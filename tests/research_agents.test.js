'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {reviewWithAgents} = require('../vendor/research_agents');
const config = {provider: 'openai', model: 'explicit-test-model', apiKey: 'test-key-never-real'};
const packet = {league: 'MLB', game_id: 12, candidate: {p_win: .6, p_push: 0, p_loss: .4}};
const decision = {mode: 'paper', verdict: 'REJECT', can_publish: false, can_place_bet: false};
function response(analysis = {status: 'OK', summary: 'Revisión del expediente.', findings: []}) {
  return {status: 200, json: async () => ({status: 'completed', model: 'explicit-test-model',
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify(analysis)}]}],
    usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120}})};
}
test('four sequential calls with explicit model, strict schema, no tools, no override', async () => {
  let active = 0, maxActive = 0; const requests = [];
  const original = structuredClone({packet, decision});
  const http = async (url, options) => {
    active++; maxActive = Math.max(maxActive, active); requests.push({url, options, body: JSON.parse(options.body)});
    await Promise.resolve(); active--; return response();
  };
  const result = await reviewWithAgents({packet, decision, config: {...config, endpoint: 'https://ignored.invalid', reasoningEffort: 'none'}, http});
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.calls, 4); assert.equal(maxActive, 1);
  assert.deepEqual(result.agents.map(x => x.role), ['datos', 'modelo', 'mercado', 'riesgo']);
  assert.equal(result.decision_verdict, 'REJECT'); assert.equal(result.can_publish, false); assert.equal(result.can_place_bet, false);
  assert.equal(result.usage.total_tokens, 480); assert.equal(result.usage.complete, true);
  assert.deepEqual({packet, decision}, original); assert.ok(!JSON.stringify(result).includes(config.apiKey));
  for (const req of requests) {
    assert.equal(req.url, 'https://api.openai.com/v1/responses'); assert.equal(req.options.timeout, 30000);
    assert.equal(req.body.model, config.model); assert.equal(req.body.store, false); assert.equal(req.body.max_output_tokens, 800);
    assert.equal(req.body.reasoning.effort, 'none'); assert.equal(req.body.text.format.strict, true);
    assert.equal(req.body.text.format.type, 'json_schema'); assert.equal(req.body.tools, undefined);
    const fields=req.body.text.format.schema.properties.findings.items.properties;
    assert.equal(fields.code.pattern,'^[A-Z0-9_]{1,80}$');
    assert.equal(fields.evidence_paths.minItems,1);
    assert(fields.evidence_paths.items.enum.includes('/packet/candidate/p_win'));
    assert(fields.evidence_paths.items.enum.includes('/decision/verdict'));
    assert(!fields.evidence_paths.items.enum.includes('/packet/nonexistent'));
  }
});
test('missing credentials/model/config performs zero HTTP calls', async () => {
  let calls = 0; const http = async () => { calls++; return response(); };
  for (const cfg of [undefined, {}, {...config, apiKey: ''}, {...config, model: ' '}, {...config, provider: ''}]) {
    assert.deepEqual(await reviewWithAgents({packet, decision, config: cfg, http}), {status: 'NOT_CONFIGURED', agents: [], calls: 0});
  }
  assert.equal(calls, 0);
});
test('research context assigns four research roles without altering production decisions',async()=>{
 const instructions=[];
 const result=await reviewWithAgents({packet:{task:'model_research',unpublished_pairs:1434},decision,config:{...config,reviewContext:'model_research'},
  http:async(_url,options)=>{instructions.push(JSON.parse(options.body).instructions);return response();}});
 assert.equal(result.calls,4);assert(instructions[0].includes('descartes incluidos'));assert(instructions[1].includes('prueba futura nueva'));
 assert.equal(result.can_publish,false);assert.equal(result.can_place_bet,false);
});
test('unsupported configuration and oversized/secret input never call transport', async () => {
  let calls = 0; const http = async () => { calls++; return response(); };
  for (const args of [
    {config: {...config, provider: 'other'}}, {config: {...config, reasoningEffort: 'made-up'}},
    {packet: {...packet, notes: 'é'.repeat(24000)}}, {packet: {...packet, token: config.apiKey}},
    {decision: {...decision, can_publish: true}},
  ]) assert.equal((await reviewWithAgents({packet, decision, config, http, ...args})).status, 'ERROR');
  assert.equal(calls, 0);
});
test('invalid schema, added authority and invented evidence paths fail closed', async () => {
  for (const analysis of [
    {status: 'BUY', summary: 'Comprar', findings: []},
    {status: 'OK', summary: 'x', findings: [], can_place_bet: true},
    {status: 'BLOCK', summary: 'x', findings: [{code: 'BAD', message: 'x', evidence_paths: ['/packet/nonexistent']}]},
  ]) {
    const result = await reviewWithAgents({packet, decision, config, http: async () => response(analysis)});
    assert.equal(result.status, 'ERROR'); assert.equal(result.calls, 1); assert.equal(result.error_code, 'MALFORMED_MODEL_OUTPUT');
    assert.equal(result.can_publish, false);
  }
});
test('valid blockers retain evidence and never erase deterministic veto', async () => {
  const analysis = {status: 'BLOCK', summary: 'Falta información.', findings: [{code: 'VETO', message: 'Decisión bloqueada.', evidence_paths: ['/decision/verdict']}]};
  const result = await reviewWithAgents({packet, decision, config, http: async () => response(analysis)});
  assert.equal(result.analysis_status, 'BLOCK'); assert.equal(result.status, 'COMPLETED'); assert.equal(result.decision_verdict, 'REJECT');
});
test('refusals, incomplete, invalid JSON and unexpected tool calls are errors', async () => {
  const variants = [
    {status: 'incomplete', output: []},
    {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'refusal', refusal: 'No.'}]}]},
    {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: '{bad json'}]}]},
    {status: 'completed', output: [{type: 'function_call', name: 'place_bet'}]},
  ];
  for (const value of variants) {
    const result = await reviewWithAgents({packet, decision, config, http: async () => ({status: 200, json: async () => value})});
    assert.equal(result.status, 'ERROR'); assert.equal(result.calls, 1);
  }
});
test('HTTP failures and transport timeouts return sanitized errors without retries', async () => {
  const transports = [
    async () => ({status: 401, json: async () => { throw new Error('must not read body'); }}),
    async () => { throw new Error('Authorization: Bearer ' + config.apiKey); },
    async () => { const e = new Error('failure'); e.safeCode = config.apiKey; throw e; },
    async () => { const e = new Error(config.apiKey); e.name = 'TimeoutError'; throw e; },
  ];
  for (const http of transports) {
    const result = await reviewWithAgents({packet, decision, config, http});
    assert.equal(result.status, 'ERROR'); assert.equal(result.calls, 1); assert.ok(!JSON.stringify(result).includes(config.apiKey));
  }
});
test('works with injected n8n transport when AbortController and timers are unavailable', async () => {
  const saved = {AbortController: globalThis.AbortController, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
  try {
    globalThis.AbortController = undefined; globalThis.setTimeout = undefined; globalThis.clearTimeout = undefined;
    const result = await reviewWithAgents({packet, decision, config, http: async (_url, opts) => { assert.equal(opts.timeout, 30000); return response(); }});
    assert.equal(result.status, 'COMPLETED');
  } finally { Object.assign(globalThis, saved); }
});


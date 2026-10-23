'use strict';
const POLICY='validated-improvement-v1';
function assessImprovement(group){
 const reasons=[];const s=(group.test_scores||[]).find(x=>x.name===group.selected_on_validation);
 const current=(group.test_scores||[]).find(x=>x.name==='current'),market=(group.test_scores||[]).find(x=>x.name==='market');
 if(group.evidence!=='prospective_sealed_predictions'||group.status!=='ready_for_review')reasons.push('TEST_NOT_COMPLETE');
 if(!['raw','fitted_blend','logistic'].includes(group.selected_on_validation))reasons.push('NO_ALTERNATIVE_SELECTED_ON_VALIDATION');
 if(group.train<400||group.validation<150||group.test<200)reasons.push('INSUFFICIENT_SAMPLE');
 const good=score=>score&&[score.brier,score.log_loss].every(x=>Number.isFinite(x)&&x>=0);
 if(!good(s)||!good(current)||!good(market))reasons.push('MISSING_SCORES');
 const gain=good(s)&&good(current)&&current.brier>0?(current.brier-s.brier)/current.brier:null;
 if(!(gain>=.02))reasons.push('BRIER_GAIN_BELOW_TWO_PERCENT');
 for(const [label,baseline,interval] of [['CURRENT',current,group.ci95_selected_minus_current],['MARKET',market,group.ci95_selected_minus_market]]){
  if(!Array.isArray(interval)||interval.length!==2||!interval.every(Number.isFinite)||interval[1]>=0)reasons.push('NO_CONFIRMED_GAIN_VS_'+label);
  if(!good(s)||!good(baseline)||s.log_loss>baseline.log_loss)reasons.push('LOG_LOSS_WORSE_VS_'+label);
 }
 return {policy:POLICY,group:group.group,improved:reasons.length===0,reasons,relative_brier_gain:gain,
  selected:group.selected_on_validation||null,test_games:group.test,can_auto_promote:false};
}
function improvementMessage(group,assessment,review){
 if(!assessment.improved)throw Error('Improvement evidence required');
 const scores=Object.fromEntries(group.test_scores.map(s=>[s.name,s]));
 const model=scores[assessment.selected],baseline=scores.current,market=scores.market;
 const labels={raw:'modelo bruto',fitted_blend:'mezcla calibrada',logistic:'calibración logística'};
 return ['📊 Candidato con mejora validada: '+(labels[assessment.selected]||assessment.selected),group.group,
  'Prueba posterior al ajuste: '+group.test+' partidos; '+(group.test_cohorts?.unpublished?.n||0)+' sin publicación.',
  'Brier (menor es mejor): candidato '+model.brier.toFixed(4)+', actual '+baseline.brier.toFixed(4)+', mercado sin margen '+market.brier.toFixed(4)+'.',
  'Mejora frente al actual: '+(assessment.relative_brier_gain*100).toFixed(1)+'%. Log-loss no empeora.',
  'Intervalo pareado 95% de la diferencia frente al actual: '+JSON.stringify(group.ci95_selected_minus_current)+'.',
  'Intervalo frente al mercado: '+JSON.stringify(group.ci95_selected_minus_market)+'.',
  'Agentes: '+(review?.status==='COMPLETED'?'cuatro revisiones registradas ('+review.analysis_status+').':'revisión pendiente o no disponible.'),
  'Modelo candidato para revisión; producción sin cambios. La precisión observada no garantiza rentabilidad futura.'].join('\n');
}
module.exports={assessImprovement,improvementMessage,POLICY};

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseCatcher,catcherUrl,inspectLmbTracking}=require('../collectors/catcher_defense');
test('framing converts fractions and preserves real zero and blank',()=>{
 const parsed=parseCatcher('id,name,pitches,rv_tot,pct_tot\n1,"Smith, A",200,0,0.49\n2,B,10,,', 'framing',2026);
 assert.equal(parsed.rows[0].metrics.shadow_strike_pct,49);
 assert.equal(parsed.rows[0].metrics.framing_runs,0);
 assert.equal(parsed.rows[1].metrics.framing_runs,null);
 assert.equal(parsed.rows[1].metrics.shadow_strike_pct,null);
});
test('source filters include unqualified catchers and exact season',()=>{
 const u=new URL(catcherUrl('blocking',2025));
 assert.equal(u.searchParams.get('season_start'),'2025');assert.equal(u.searchParams.get('season_end'),'2025');
 assert.equal(u.searchParams.get('n'),'1');assert.equal(u.searchParams.get('with_team_only'),'0');
 assert.equal(u.searchParams.get('game_type'),'Regular');
 assert.equal(new URL(catcherUrl('framing',2026)).searchParams.get('minPitches'),'0');
 assert.equal(new URL(catcherUrl('poptime',2026)).searchParams.get('min3b'),'0');
});
test('invalid fractions are excluded and duplicates and HTML rejected',()=>{
 const p=parseCatcher('id,name,pitches,rv_tot,pct_tot\n1,A,200,-5,49','framing',2026);
 assert.equal(p.rows[0].metrics.shadow_strike_pct,null);assert.deepEqual(p.rows[0].quality_flags,['invalid_shadow_strike_pct']);
 assert.throws(()=>parseCatcher('<html>error</html>','framing',2026));
 assert.throws(()=>parseCatcher('id,name,pitches,rv_tot,pct_tot\n1,A,2,0,0\n1,A,2,0,0','framing',2026));
});
test('LMB coordinate-only pitches are not mislabeled as tracking',()=>{
 const feed={gamePk:1,gameData:{teams:{home:{sport:{id:23}},away:{sport:{id:23}}},status:{abstractGameState:'Final'}},
  liveData:{plays:{allPlays:[{playEvents:[{isPitch:true,pitchData:{coordinates:{x:10,y:10},breaks:{}},details:{isInPlay:true},hitData:{coordinates:{coordX:1,coordY:2}}}]}]}}};
 let p=inspectLmbTracking(feed);assert.equal(p.pitches,1);assert.equal(p.pitch_velocity,0);assert.equal(p.exit_velocity,0);
 feed.liveData.plays.allPlays[0].playEvents[0].hitData={launchSpeed:95,launchAngle:0};
 p=inspectLmbTracking(feed);assert.equal(p.launch_angle,1);assert.equal(p.exit_velocity,1);
 feed.gameData.teams.home.sport.id=1;assert.throws(()=>inspectLmbTracking(feed));
});

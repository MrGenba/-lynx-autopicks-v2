const {test}=require('node:test');
const assert=require('node:assert/strict');
const {statcastNumber,statcastUrl,parseStatcast}=require('../collectors/statcast');
const header='player_id,player_name,pitches,pa,xwoba,hardhit_percent,k_percent,bb_percent,xslg,barrels_total';
test('missing numbers are not fabricated zeros',()=>{
 for(const v of ['', ' ',null,undefined,'null','NaN'])assert.equal(statcastNumber(v),null);
 assert.equal(statcastNumber('0'),0);
});
test('hard hit is a percentage and CSV quoted names stay intact',()=>{
 const p=parseStatcast(header+'\n800048,"Messick, Parker",291,66,.329,52.6315,25.8,15.2,.359,3\n',{});
 assert.equal(p.rows[0].player_name,'Messick, Parker');
 assert.equal(p.rows[0].hard_hit_pct,52.6315);
 assert.equal(p.rows[0].xslg,.359);
 assert.equal(p.rows[0].barrels_total,3);
 assert.equal(p.rows[0].sweet_spot_pct,null);
});
test('out of range percentages are excluded and flagged',()=>{
 const p=parseStatcast(header+'\n123,A,10,4,.3,140,25,5,,\n',{});
 assert.equal(p.rows[0].hard_hit_pct,null);
 assert.deepEqual(p.rows[0].quality_flags,['invalid_hard_hit_pct']);
});
test('changed schema, HTML, truncated and duplicate records fail closed',()=>{
 for(const text of ['<html>Error</html>','id,name\n1,A',header+'\n1,"Unclosed',header+'\n1,A,1,1,.3,50,20,5,,\n1,A,1,1,.3,50,20,5,,'])assert.throws(()=>parseStatcast(text,{}));
});
test('MLB and AAA use independent filters and regular/postseason never merge',()=>{
 const mlb=new URL(statcastUrl(1,'pitcher',2026,'R','2026-10-22'));
 const aaa=new URL(statcastUrl(11,'batter',2026,'POST','2026-10-22'));
 assert.equal(mlb.searchParams.get('minors'),'false');
 assert.equal(mlb.searchParams.get('hfGT'),'R|');
 assert.equal(aaa.searchParams.get('hfLevel'),'AAA|');
 assert.equal(aaa.searchParams.get('hfGT'),'F|D|L|W|');
 assert.equal(aaa.searchParams.get('game_date_lt'),'2026-10-22');
});

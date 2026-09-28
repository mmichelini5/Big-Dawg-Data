// Big Dawg Invitational data pull. Runs on GitHub's servers on a schedule (see .github/workflows/pull.yml).
// Writes data/live_espn.json (ESPN league data) and data/live_sheet.json (commissioner sheet) for the site builder.
import {writeFileSync,mkdirSync} from 'node:fs';
const HDR={'Accept':'application/json','User-Agent':'Mozilla/5.0 (BigDawgSiteBot)'};
// Clean up the two ESPN login values (stray spaces/quotes, missing braces, un-encoded espn_s2) and log a safe check.
let S2=(process.env.ESPN_S2||'').trim().replace(/^["']|["']$/g,'').replace(/^espn_s2=/i,'');
let SW=(process.env.SWID||'').trim().replace(/^["']|["']$/g,'').replace(/^SWID=/i,'');
if(S2&&!/%[0-9A-Fa-f]{2}/.test(S2)&&/[+/=]/.test(S2))S2=encodeURIComponent(S2);
if(SW&&!SW.startsWith('{'))SW='{'+SW+'}';
console.log(`Login check: ESPN_S2 ${S2?`found (${S2.length} characters)`:'MISSING'}, SWID ${SW?(/^\{[0-9A-Fa-f-]{36}\}$/.test(SW)?'found, looks right':`found but unusual format (${SW.length} characters)`):'MISSING'}`);
if(S2&&SW)HDR.Cookie=`espn_s2=${S2}; SWID=${SW}`;
mkdirSync('data',{recursive:true});

async function pullEspn(){
const Y=2026,LID=564024186,B=`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${Y}/segments/0/leagues/${LID}`;
const get=async(q,h)=>{const r=await fetch(B+q,{headers:{...HDR,...(h||{})}});if(!r.ok)throw new Error(`ESPN answered ${r.status} for ${q.slice(0,40)}. If this is 401, the league is not public: make it viewable to the public, or add the ESPN_S2 and SWID secrets.`);return r.json()};
const PN={1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'D/ST'};const SL={0:'QB',2:'RB',4:'WR',6:'TE',23:'FLEX',16:'DST',17:'K',20:'BN',21:'IR'};
const TIER={NONE:'N',WINNERS_BRACKET:'W',WINNERS_CONSOLATION_LADDER:'C',LOSERS_CONSOLATION_LADDER:'L'};
const r2=v=>Math.round(v*100)/100;
const j=await get('?view=mTeam&view=mMatchupScore&view=mSettings&view=mStatus&view=mDraftDetail&view=mRoster');
const mem={};j.members.forEach(m=>mem[m.id]=(m.firstName+' '+m.lastName).trim());
const mgr={};j.teams.forEach(t=>mgr[t.id]=(t.owners||[]).map(o=>mem[o]).join(' & '));
const reg=j.settings.scheduleSettings.matchupPeriodCount;
const games=[],remaining=[];let week=0;const byWk={};
for(const g of j.schedule){if(!g.away)continue;const w=g.matchupPeriodId;(byWk[w]=byWk[w]||[]).push(g);}
Object.keys(byWk).map(Number).sort((a,b)=>a-b).forEach(w=>{const gs=byWk[w];const done=gs.every(g=>g.winner&&g.winner!=='UNDECIDED');if(done&&w===week+1)week=w;
  gs.forEach(g=>{if(g.winner&&g.winner!=='UNDECIDED')games.push([w,g.home.teamId,g.away.teamId,r2(g.home.totalPoints),r2(g.away.totalPoints),TIER[g.playoffTierType]||'N']);else if(w<=reg)remaining.push([w,g.home.teamId,g.away.teamId]);});});
const played=games.filter(g=>g[0]<=week);
const teams=j.teams.map(t=>{const tc=t.transactionCounter||{};return [t.id,(t.name||(t.location+' '+t.nickname)).trim(),mgr[t.id],t.rankCalculatedFinal||0,t.playoffSeed,[tc.acquisitions||0,tc.drops||0,tc.trades||0,tc.moveToActive||0,tc.acquisitionBudgetSpent||0]]});
// current rosters with season points
const seasonPts=p=>{const s=(p.stats||[]).find(s=>s.seasonId===Y&&s.statSourceId===0&&s.statSplitTypeId===0);return s?r2(s.appliedTotal):0};
const pt=await (await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${Y}?view=proTeamSchedules_wl`,{headers:HDR})).json();const PRO={};const PROG={};((pt.settings&&pt.settings.proTeams)||[]).forEach(t=>{PRO[t.id]=[t.abbrev,t.byeWeek];PROG[t.id]=t.proGamesByScoringPeriod||{}});
const stat=(p,src,split,sp)=>{const s=(p.stats||[]).find(s=>s.seasonId===Y&&s.statSourceId===src&&s.statSplitTypeId===split&&(sp==null||s.scoringPeriodId===sp));return s?r2(s.appliedTotal):0};
const nextW=(j.status&&j.status.currentMatchupPeriod)||0;
// roster row: [name,pos,seasonPts,proTeam,bye,slot S/B/IR,seasonProj,nextWeekProj,injuryStatus]
const roster={};j.teams.forEach(t=>roster[t.id]=(t.roster?t.roster.entries:[]).map(e=>{const p=e.playerPoolEntry.player;const pr=PRO[p.proTeamId]||['FA',0];return [p.fullName,PN[p.defaultPositionId]||'?',seasonPts(p),pr[0],pr[1],e.lineupSlotId===21?'IR':e.lineupSlotId===20?'B':'S',stat(p,1,0),(()=>{const ss=(p.stats||[]).filter(s=>s.seasonId===Y&&s.statSourceId===1&&s.statSplitTypeId===1).sort((a,b)=>b.scoringPeriodId-a.scoringPeriodId);return ss.length?r2(ss[0].appliedTotal):0})(),p.injuryStatus||'ACTIVE']}));
// season points for every drafted player
const ids=[...new Set(j.draftDetail.picks.map(p=>p.playerId))];const pickPts={};
for(let i=0;i<ids.length;i+=40){const k=await get('?view=kona_player_info',{'x-fantasy-filter':JSON.stringify({players:{filterIds:{value:ids.slice(i,i+40)}}})});(k.players||[]).forEach(pp=>{const p=pp.player;const st=(p.stats||[]).find(s=>s.id==='00'+Y);pickPts[p.fullName]=st?r2(st.appliedTotal):0});}
// box scores
const liveT={};const WKP={};const optWk={};const slot={},weekTop=[],weekBench=[],starter={},names={},proj={},ice=[],mv={},lu={};
const optimal=ents=>{const pool=ents.filter(e=>e.sl!=='IR').map(e=>({...e}));const take=(pos,n)=>{let s=0;for(let i=0;i<n;i++){const c=pool.filter(e=>pos.includes(e.pos)&&!e.u).sort((a,b)=>b.pts-a.pts)[0];if(c){c.u=1;s+=c.pts}}return s};
  return take(['QB'],1)+take(['RB'],2)+take(['WR'],3)+take(['TE'],1)+take(['RB','WR','TE'],1)+take(['D/ST'],1)+take(['K'],1)};
const lastWk=Math.min(week+1,17);
for(let w=1;w<=lastWk;w++){const b=await get(`?view=mBoxscore&view=mMatchupScore&scoringPeriodId=${w}`);let best=null,bb=null;
  for(const g of b.schedule){if(g.matchupPeriodId!==w)continue;for(const side of [g.home,g.away]){if(!side||!side.rosterForCurrentScoringPeriod)continue;const tid=side.teamId;const ents=[];let pr=0;
    for(const e of side.rosterForCurrentScoringPeriod.entries){const p=e.playerPoolEntry.player;names[p.id]=p.fullName;const st=p.stats||[];const a=st.find(s=>s.scoringPeriodId===w&&s.statSourceId===0);const q=st.find(s=>s.scoringPeriodId===w&&s.statSourceId===1);const pts=a?a.appliedTotal:0;const sl=SL[e.lineupSlotId]||'X';const pos=PN[p.defaultPositionId]||'?';
      const isStart=sl!=='BN'&&sl!=='IR';if(isStart)pr+=q?q.appliedTotal:0;
      if(w===week+1&&isStart){const gm=((PROG[p.proTeamId]||{})[w]||[])[0];const now=Date.now();const state=!gm?'bye':(gm.statsOfficial||now>gm.date+4*36e5)?'done':now>=gm.date?'live':'yet';
        const L=(liveT[tid]=liveT[tid]||[]);L.push([p.fullName,pos,sl,r2(pts),r2(q?q.appliedTotal:0),state,gm?gm.date:0]);}
      if(w>week)continue;
      (WKP[w]=WKP[w]||[]).push([tid,p.fullName,pos,sl,r2(pts),r2(q?q.appliedTotal:0)]);
      ents.push({sl,pos,pts});
      if(w<=reg){slot[tid]=slot[tid]||{};slot[tid][sl]=(slot[tid][sl]||0)+pts}
      if(isStart){starter[tid+'|'+p.id+'|'+w]=pts;if(!best||pts>best[4])best=[w,tid,p.fullName,pos,r2(pts)];if(p.defaultPositionId!==16&&pts<=0)ice.push([w,tid,p.fullName,pos,r2(pts)]);
        const m=(mv[tid]=mv[tid]||{});const x=(m[p.fullName]=m[p.fullName]||[p.fullName,pos,0,0]);x[2]+=pts;x[3]++;}
      else if(sl==='BN'){if(!bb||pts>bb[4])bb=[w,tid,p.fullName,pos,r2(pts)]}}
    (proj[w]=proj[w]||{})[tid]=r2(pr);
    if(w<=week){const act=ents.filter(e=>e.sl!=='BN'&&e.sl!=='IR').reduce((s,e)=>s+e.pts,0),bn=ents.filter(e=>e.sl==='BN').reduce((s,e)=>s+e.pts,0),opt=Math.max(optimal(ents),act);(optWk[w]=optWk[w]||{})[tid]=r2(opt);const L=(lu[tid]=lu[tid]||[0,0,0,0,0]);L[0]+=act;L[1]+=bn;L[2]+=opt;L[3]+=opt-act;if(opt-act<0.01)L[4]++;}
  }}
  if(w<=week){if(best)weekTop.push(best);if(bb)weekBench.push(bb);}}
for(const k in slot)for(const s in slot[k])slot[k][s]=r2(slot[k][s]);
// transactions: waiver/FA adds and trades
const adds=[],trades=[];const seenT=new Set();
for(let w=0;w<=lastWk;w++){const tj=await get(`?view=mTransactions2&scoringPeriodId=${w}`);
  for(const t of tj.transactions||[]){if(t.status!=='EXECUTED')continue;
    if(t.type==='WAIVER'||t.type==='FREEAGENT'){for(const it of t.items||[])if(it.type==='ADD')adds.push({w:t.scoringPeriodId,tid:it.toTeamId,pid:it.playerId,bid:t.bidAmount||0})}
    if(/^TRADE/.test(t.type)){for(const it of t.items||[]){if(it.type!=='TRADE')continue;const k=it.playerId+'|'+it.fromTeamId+'|'+it.toTeamId+'|'+t.scoringPeriodId;if(seenT.has(k))continue;seenT.add(k);trades.push({id:t.relatedTransactionId||t.id,w:t.scoringPeriodId,date:new Date(t.processDate||t.proposedDate).toISOString().slice(0,10),pid:it.playerId,from:it.fromTeamId,to:it.toTeamId})}}}}
const seenA=new Set();const faab={};
adds.filter(a=>{const k=a.tid+'|'+a.pid+'|'+a.w;if(seenA.has(k))return false;seenA.add(k);return true}).forEach(a=>{let pts=0;for(let w=a.w;w<=17;w++){const v=starter[a.tid+'|'+a.pid+'|'+w];if(v!=null)pts+=v}const f=faab[a.tid]=faab[a.tid]||{adds:0,spent:0,pts:0,best:null};f.adds++;f.spent+=a.bid;f.pts+=pts;if(!f.best||pts>f.best[2])f.best=[names[a.pid]||String(a.pid),a.bid,Math.round(pts*10)/10]});
for(const k in faab)faab[k].pts=Math.round(faab[k].pts*10)/10;
// trade rows need player names/positions: look them up
const tids=[...new Set(trades.map(t=>t.pid))].filter(id=>!names[id]);
if(tids.length){const k=await get('?view=kona_player_info',{'x-fantasy-filter':JSON.stringify({players:{filterIds:{value:tids}}})});(k.players||[]).forEach(pp=>names[pp.player.id]=pp.player.fullName);}
const posOf={};j.teams.forEach(t=>(t.roster?t.roster.entries:[]).forEach(e=>posOf[e.playerPoolEntry.player.fullName]=PN[e.playerPoolEntry.player.defaultPositionId]));
const tradeIds=[...new Set(trades.map(t=>t.id))];
const tradeRows=trades.map(t=>{let pts=0;for(let w=t.w;w<=17;w++){const v=starter[t.to+'|'+t.pid+'|'+w];if(v!=null)pts+=v}const nm=names[t.pid]||String(t.pid);return [Y,tradeIds.indexOf(t.id)+1,t.w,t.date,nm,posOf[nm]||'',mgr[t.from],mgr[t.to],r2(pts)]});
const mvps={};for(const tid in mv){mvps[mgr[tid]]=Object.values(mv[tid]).sort((a,b)=>b[2]-a[2]).slice(0,3).map(x=>[x[0],x[1],r2(x[2]),x[3]])}
const lineup=Object.entries(lu).map(([tid,L])=>[Y,mgr[tid],r2(L[0]),r2(L[1]),r2(L[2]),r2(L[3]),L[4]]);
const nextProj=proj[week+1]||{};
const liveW=week+1;const live=liveW<=17?{week:liveW,updated:new Date().toISOString(),teams:liveT,matchups:(byWk[liveW]||[]).map(g=>[g.home.teamId,g.away.teamId,TIER[g.playoffTierType]||'N'])}:null;
const out={live,pulled:new Date().toISOString(),week,teams,games:played,remaining,pickPts,roster,box:{slot,weekTop,weekBench,faab,proj:nextProj},proj:Object.fromEntries(Object.entries(proj).filter(([w])=>+w<=week)),ice,mvps,lineup,trades:tradeRows,optWk,players:WKP};
writeFileSync('data/live_espn.json',JSON.stringify(out));
return `ESPN: week ${week}, games ${played.length}, trades ${tradeRows.length}, live week ${live&&live.week}`;
}

async function pullSheet(){
const ID='1V6SsA25HSt2R1MrJAQybCkL72XUDNs3fNq1AV5GNKUA';
const csv=async n=>{const r=await fetch(`https://docs.google.com/spreadsheets/d/${ID}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(n)}`);if(!r.ok)throw new Error(`Google Sheets answered ${r.status} for tab "${n}". Make sure the sheet is shared as "Anyone with the link can view".`);return r.text()};
const parse=t=>t.trim().split('\n').map(l=>{const o=[];let c='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(ch=='"'){if(q&&l[i+1]=='"'){c+='"';i++}else q=!q}else if(ch==','&&!q){o.push(c);c=''}else c+=ch}o.push(c);return o.map(s=>s.trim())});
const num=s=>s===''?null:Number(String(s).replace(/[$,]/g,''));
const gotw=parse(await csv('GOTW (auto)')).filter(r=>/^\d+$/.test(r[0])).map(r=>[+r[0],r[1],r[2],r[3]||'',num(r[4]),num(r[5]),r[7]==='Final'?'Final':r[7]==='Live'?'This week':'Upcoming']);
const vr=parse(await csv('GOTW Votes (auto)')).filter(r=>/^\d+$/.test(r[0]));
const vweek=vr.length?Math.max(...vr.map(r=>+r[0])):null;
const votes=vr.filter(r=>+r[0]===vweek&&/^Counted/.test(r[4])).map(r=>[r[1],r[2]]);
const correct={};parse(await csv('Salary Ledger (auto)')).forEach(r=>{const m=(r[4]||'').match(/Correct GOTW pick, Week (\d+)/);if(m){(correct[m[1]]=correct[m[1]]||[]).push(r[1])}});
const balances=parse(await csv('Balances (auto)')).filter(r=>r[0]&&r[0]!=='Manager'&&r[1]).map(r=>[r[0],num(r[1]),num(r[2])]);
const po=parse(await csv('Pick Ownership (auto)'));const hdr=po.find(r=>r[0]===''&&r.length>2)||po[0];const teams=hdr.slice(1).filter(Boolean);
const picks27={};po.filter(r=>/^\d+$/.test(r[0])).forEach(r=>teams.forEach((t,i)=>{const o=r[i+1];if(o&&o!==t){(picks27[t]=picks27[t]||{})[r[0]]=o}}));
if(!gotw.length||!balances.length)throw new Error('The commissioner sheet came back empty. Make sure it is shared as "Anyone with the link can view".');
const out={gotw,votes:{week:vweek,votes},correct,balances,picks27};

writeFileSync('data/live_sheet.json',JSON.stringify(out));
return `Sheet: GOTW rows ${gotw.length}, votes week ${vweek} (${votes.length}), balances ${balances.length}`;
}

let failed=false;
for(const f of [pullEspn,pullSheet]){try{console.log(await f())}catch(e){failed=true;console.error(f.name+' failed: '+e.message)}}
writeFileSync('data/status.json',JSON.stringify({ran:new Date().toISOString(),ok:!failed}));
if(failed)process.exit(1);

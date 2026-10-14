/** Original artwork composition for three approved Gravewright action decks.
 * Browser canvas only: exact indices and pips never come from generated text.
 */
export const WIDTH = 600;
export const HEIGHT = 900;
export const SUITS = Object.freeze([
  {id:'spades', symbol:'♠', red:false}, {id:'hearts', symbol:'♥', red:true},
  {id:'diamonds', symbol:'♦', red:true}, {id:'clubs', symbol:'♣', red:false},
]);
export const RANKS = Object.freeze(['A','K','Q','J','10','9','8','7','6','5','4','3','2']);
export const THEMES = Object.freeze({
  ivory:{title:'Clássico marfim',paper:'#eee7d6',light:'#f8f2df',ink:'#20211e',red:'#8e1c29',gold:'#a88646',line:'#bda068',back:'#20241f'},
  gravewright:{title:'Gravewright escuro',paper:'#20252b',light:'#2b3034',ink:'#e4cd99',red:'#ce766b',gold:'#c49b59',line:'#927746',back:'#20252b'},
  adventure:{title:'Gravura de aventura',paper:'#eee2c8',light:'#faf0d6',ink:'#25231f',red:'#892f28',gold:'#a58044',line:'#967647',back:'#242522'},
});

export function cardSpecs() {
  return [...SUITS.flatMap(suit=>RANKS.map(rank=>({rank,suit:suit.id,name:`${rank}${suit.symbol}`,file:`${suit.id}-${rank.toLowerCase()}.webp`}))),
    {joker:1,name:'★ 1',file:'joker-1.webp'}, {joker:2,name:'★ 2',file:'joker-2.webp'}];
}

/** Central pips only; the two small corner signs are separate indices. */
export function pipLayout(rank) {
  const n=Number(rank), a=205, b=395, center=300;
  const pair=y=>[{x:a,y},{x:b,y}];
  let points;
  switch(n) {
    case 2: points=[{x:center,y:250},{x:center,y:650}];break;
    case 3: points=[{x:center,y:250},{x:center,y:450},{x:center,y:650}];break;
    case 4: points=[...pair(250),...pair(650)];break;
    case 5: points=[...pair(250),{x:center,y:450},...pair(650)];break;
    case 6: points=[...pair(240),...pair(450),...pair(660)];break;
    case 7: points=[...pair(240),...pair(450),{x:center,y:450},...pair(660)];break;
    case 8: points=[...pair(240),{x:center,y:345},...pair(450),{x:center,y:555},...pair(660)];break;
    case 9: points=[...pair(215),...pair(372),{x:center,y:450},...pair(528),...pair(685)];break;
    case 10: points=[...pair(215),{x:center,y:294},...pair(372),...pair(528),{x:center,y:606},...pair(685)];break;
    default: throw new TypeError('Numeric pips require rank 2 through 10');
  }
  return points.map(point=>({...point,angle:point.y>450?Math.PI:0}));
}

const pathDefinitions={
  hearts:'M0 .43 C-.12 .30,-.50 .02,-.50 -.22 C-.50 -.53,-.14 -.61,0 -.31 C.14 -.61,.50 -.53,.50 -.22 C.50 .02,.12 .30,0 .43 Z',
  spades:'M0 -.50 C-.10 -.34,-.46 -.04,-.46 .18 C-.46 .45,-.11 .51,-.03 .27 C-.05 .40,-.10 .46,-.16 .50 L.16 .50 C.10 .46,.05 .40,.03 .27 C.11 .51,.46 .45,.46 .18 C.46 -.04,.10 -.34,0 -.50 Z',
  diamonds:'M0 -.52 L.39 0 L0 .52 L-.39 0 Z',
  clubs:'M0 -.49 C-.25 -.49,-.31 -.17,-.15 -.06 C-.49 -.22,-.60 .10,-.45 .27 C-.33 .43,-.11 .34,-.04 .18 C-.04 .34,-.10 .46,-.18 .50 L.18 .50 C.10 .46,.04 .34,.04 .18 C.11 .34,.33 .43,.45 .27 C.60 .10,.49 -.22,.15 -.06 C.31 -.17,.25 -.49,0 -.49 Z',
};
function suitPath(suit) {return new Path2D(pathDefinitions[suit]);}
function suit(ctx,suitId,x,y,size,color,angle=0) {
  ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(size,size);ctx.fillStyle=color;ctx.fill(suitPath(suitId));ctx.restore();
}
function line(ctx,points,color,width=1) {
  ctx.beginPath();ctx.moveTo(...points[0]);for(const p of points.slice(1))ctx.lineTo(...p);
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
}
function curve(ctx,commands,color,width=1) {
  ctx.beginPath();for(const [kind,...points]of commands)ctx[kind](...points);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
}
function roundRect(ctx,x,y,w,h,r,{fill,stroke,width=1}={}) {
  ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke();}
}
function star(ctx,x,y,r,color,points=8,inner=.27,angle=0) {
  ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.beginPath();for(let i=0;i<points*2;i++){
    const a=-Math.PI/2+i*Math.PI/points,rr=i%2?r*inner:r;
    const p=[Math.cos(a)*rr,Math.sin(a)*rr];i?ctx.lineTo(...p):ctx.moveTo(...p);
  }ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.restore();
}
function compass(ctx,x,y,r,palette,{rays=true}={}) {
  ctx.save();ctx.translate(x,y);const gold=palette.gold;
  for(const scale of [.55,.68]){ctx.beginPath();ctx.arc(0,0,r*scale,0,Math.PI*2);ctx.strokeStyle=gold;ctx.lineWidth=1.2;ctx.stroke();}
  if(rays)for(let i=0;i<32;i++){
    const a=i*Math.PI/16,outer=i%4===0?r*1.1:r*.91,inner=i%4===0?r*.80:r*.76;
    line(ctx,[[Math.cos(a)*inner,Math.sin(a)*inner],[Math.cos(a)*outer,Math.sin(a)*outer]],gold,i%4===0?1.5:.7);
  }
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4-Math.PI/2,rr=i%2?r*.58:r;
    ctx.save();ctx.rotate(a);ctx.beginPath();ctx.moveTo(rr,0);ctx.lineTo(0,-r*.14);ctx.lineTo(0,0);ctx.closePath();ctx.fillStyle=gold;ctx.fill();
    ctx.beginPath();ctx.moveTo(rr,0);ctx.lineTo(0,r*.14);ctx.lineTo(0,0);ctx.closePath();ctx.fillStyle=palette.back;ctx.fill();ctx.strokeStyle=gold;ctx.lineWidth=.7;ctx.stroke();ctx.restore();
  }
  ctx.beginPath();ctx.arc(0,0,r*.105,0,Math.PI*2);ctx.fillStyle=gold;ctx.fill();ctx.restore();
}
function flourish(ctx,x,y,scale,color,mirror=false) {
  ctx.save();ctx.translate(x,y);ctx.scale(mirror?-scale:scale,scale);
  curve(ctx,[['moveTo',0,0],['bezierCurveTo',30,-30,63,-14,40,9],['bezierCurveTo',22,27,4,4,23,-1],['bezierCurveTo',42,-7,40,21,23,36],['bezierCurveTo',7,52,15,74,33,58]],color,1.5);
  curve(ctx,[['moveTo',9,4],['bezierCurveTo',23,16,8,24,-5,25],['bezierCurveTo',-15,25,-20,16,-27,20]],color,1);
  for(let i=0;i<4;i++){
    const yy=13+i*12;curve(ctx,[['moveTo',20,yy],['bezierCurveTo',44,yy-7,49,yy+12,28,yy+14]],color,.8);
  }ctx.restore();
}
function grain(ctx,palette,theme) {
  let seed=theme==='adventure'?0x5215:0x3829;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  ctx.save();ctx.globalAlpha=theme==='gravewright'?.035:.047;ctx.fillStyle=theme==='gravewright'?'#d0c0a1':'#70593e';
  for(let i=0;i<(theme==='adventure'?4200:2100);i++){const x=random()*WIDTH,y=random()*HEIGHT;ctx.fillRect(x,y,random()*1.4+.3,random()*1.3+.3);}ctx.restore();
}
function faceBase(ctx,palette,theme) {
  const gradient=ctx.createRadialGradient(270,340,50,300,450,700);gradient.addColorStop(0,palette.light);gradient.addColorStop(1,palette.paper);
  roundRect(ctx,0,0,WIDTH,HEIGHT,24,{fill:gradient});grain(ctx,palette,theme);
  roundRect(ctx,14,14,572,872,16,{stroke:palette.gold,width:2.3});
  roundRect(ctx,24,24,552,852,10,{stroke:palette.line,width:1.1});
  if(theme==='ivory')roundRect(ctx,28,28,544,844,8,{stroke:palette.line,width:.65});
  if(theme==='adventure')for(const [x,y,angle] of [[34,34,0],[566,34,Math.PI/2],[566,866,Math.PI],[34,866,Math.PI*1.5]]){
    ctx.save();ctx.translate(x,y);ctx.rotate(angle);flourish(ctx,0,0,.8,palette.line);flourish(ctx,0,0,.46,palette.line,true);ctx.restore();
  }
  if(theme==='gravewright')for(const [x,y] of [[31,31],[569,31],[31,869],[569,869]])star(ctx,x,y,9,palette.gold,4,.15);
}
function indices(ctx,rank,suitId,palette) {
  const definition=SUITS.find(s=>s.id===suitId),color=definition.red?palette.red:palette.ink;
  function one() {
    ctx.font=`600 ${rank==='10'?79:94}px Georgia, 'Times New Roman', serif`;ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillText(rank,65,117);
    suit(ctx,suitId,65,159,43,color);
  }
  one();ctx.save();ctx.translate(WIDTH,HEIGHT);ctx.rotate(Math.PI);one();ctx.restore();
}
function ornateAce(ctx,suitId,palette,theme) {
  const red=SUITS.find(s=>s.id===suitId).red, ink=red?palette.red:palette.ink,size=suitId==='diamonds'?335:345;
  ctx.save();ctx.translate(300,445);ctx.scale(size,size);ctx.fillStyle=ink;ctx.fill(suitPath(suitId));ctx.strokeStyle=palette.gold;ctx.lineWidth=.007;ctx.stroke(suitPath(suitId));ctx.restore();
  ctx.save();ctx.translate(300,445);ctx.scale(size,size);ctx.clip(suitPath(suitId));ctx.setTransform(1,0,0,1,0,0);
  const inverse={...palette,back:ink};compass(ctx,300,430,theme==='gravewright'?72:67,inverse);
  for(let i=0;i<8;i++){const a=i*Math.PI/4;flourish(ctx,300+Math.cos(a)*105,430+Math.sin(a)*104,.44,palette.gold,i%2===0);}
  ctx.restore();
  for(const y of [185,708]){star(ctx,300,y,19,palette.gold,4,.14);line(ctx,[[300,y-31],[300,y+31]],palette.gold,.8);}
}

export async function loadArt(url) {
  const image=new Image();image.src=url;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,image.width,image.height).data;
  let x1=image.width,y1=image.height,x2=0,y2=0;
  // Ignore tiny alpha noise outside the generated cutout when measuring bounds.
  for(let y=0;y<image.height;y+=2)for(let x=0;x<image.width;x+=2)if(pixels[(y*image.width+x)*4+3]>48){x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y);}
  if(x2<=x1||y2<=y1)throw new Error('Empty generated illustration: '+url);
  return {image,bounds:{x:x1,y:y1,w:x2-x1+2,h:y2-y1+2}};
}
function portrait(ctx,art,palette,theme,{joker=0}={}) {
  const {image,bounds:b}=art;
  const width=joker&&theme==='gravewright'?310:378,halfHeight=joker&&theme==='gravewright'?355:344;
  // A square chest crop avoids shrinking a full waist-up portrait into each half.
  const sourceHeight=Math.min(b.h,b.w*(theme==='gravewright'&&joker?1.15:1.07));
  const targetX=(WIDTH-width)/2,targetY=450-halfHeight;
  if(theme!=='adventure'){
    ctx.save();ctx.strokeStyle=palette.gold;ctx.globalAlpha=.8;ctx.lineWidth=1.2;
    ctx.beginPath();ctx.arc(300,278,148,Math.PI,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.arc(300,622,148,0,Math.PI);ctx.stroke();ctx.restore();
  }
  function half(){ctx.save();ctx.beginPath();ctx.rect(110,94,380,356);ctx.clip();
    if(joker===2)ctx.filter=theme==='gravewright'?'grayscale(1) sepia(.36)':'grayscale(1) sepia(.15)';
    ctx.drawImage(image,b.x,b.y,b.w,sourceHeight,targetX,targetY,width,halfHeight);ctx.restore();}
  half();ctx.save();ctx.translate(WIDTH,HEIGHT);ctx.rotate(Math.PI);half();ctx.restore();
  line(ctx,[[111,450],[489,450]],palette.gold,1.6);
}
function jokerIndices(ctx,number,palette) {
  const color=number===1?palette.red:palette.ink;
  function one(){ctx.fillStyle=color;ctx.font="600 33px Georgia, 'Times New Roman', serif";ctx.textAlign='center';ctx.textBaseline='alphabetic';
    for(const [i,letter]of [...'JOKER'].entries())ctx.fillText(letter,63,112+i*39);
    star(ctx,63,330,19,color,5,.46);ctx.font="600 26px Georgia, 'Times New Roman', serif";ctx.fillText(String(number),63,375);
  }one();ctx.save();ctx.translate(WIDTH,HEIGHT);ctx.rotate(Math.PI);one();ctx.restore();
}
function courtBadge(ctx,suitId,palette) {
  const color=SUITS.find(s=>s.id===suitId).red?palette.red:palette.ink;
  for(const [x,y]of [[465,398],[135,502]]){ctx.beginPath();ctx.arc(x,y,21,0,Math.PI*2);ctx.fillStyle=palette.paper;ctx.fill();ctx.strokeStyle=palette.gold;ctx.lineWidth=1;ctx.stroke();suit(ctx,suitId,x,y,27,color,y>450?Math.PI:0);}
}

export function renderFace(themeId,card,arts) {
  const palette=THEMES[themeId];if(!palette)throw new TypeError('Unknown theme');
  const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;const ctx=canvas.getContext('2d');
  faceBase(ctx,palette,themeId);
  if(card.joker){portrait(ctx,arts.joker,palette,themeId,{joker:card.joker});jokerIndices(ctx,card.joker,palette);}
  else {
    const definition=SUITS.find(s=>s.id===card.suit);if(!definition||!RANKS.includes(card.rank))throw new TypeError('Unknown card');
    const color=definition.red?palette.red:palette.ink;
    if(card.rank==='A')ornateAce(ctx,card.suit,palette,themeId);
    else if(['K','Q','J'].includes(card.rank)){portrait(ctx,arts[card.rank],palette,themeId);courtBadge(ctx,card.suit,palette);}
    else for(const p of pipLayout(card.rank))suit(ctx,card.suit,p.x,p.y,themeId==='gravewright'?83:78,color,p.angle);
    indices(ctx,card.rank,card.suit,palette);
  }
  return canvas;
}

export function renderBack(themeId) {
  const palette=THEMES[themeId];if(!palette)throw new TypeError('Unknown theme');
  const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;const ctx=canvas.getContext('2d');
  roundRect(ctx,0,0,WIDTH,HEIGHT,24,{fill:palette.back});
  for(const [inset,width]of [[14,3],[24,1],[33,1.4]])roundRect(ctx,inset,inset,WIDTH-inset*2,HEIGHT-inset*2,14,{stroke:palette.gold,width});
  ctx.save();roundRect(ctx,42,42,516,816,8);ctx.clip();
  if(themeId==='ivory'){
    ctx.globalAlpha=.25;
    for(let i=-900;i<1500;i+=25){line(ctx,[[i,0],[i+900,900]],palette.gold,.8);line(ctx,[[i,900],[i+900,0]],palette.gold,.8);}
    ctx.globalAlpha=1;
    for(const [x,y]of [[55,55],[545,55],[55,845],[545,845]])compass(ctx,x,y,21,palette);
    ctx.beginPath();ctx.ellipse(300,450,171,247,0,0,Math.PI*2);ctx.fillStyle=palette.back;ctx.fill();ctx.strokeStyle=palette.gold;ctx.lineWidth=2;ctx.stroke();
    ctx.beginPath();ctx.ellipse(300,450,157,230,0,0,Math.PI*2);ctx.strokeStyle=palette.gold;ctx.lineWidth=1;ctx.stroke();
    for(const [x,y,flip]of [[145,250,false],[455,250,true],[145,575,false],[455,575,true]])flourish(ctx,x,y,1.45,palette.gold,flip);
  }else if(themeId==='gravewright'){
    for(const inset of [0,13,23])line(ctx,[[300,70+inset],[540-inset,450],[300,830-inset],[60+inset,450],[300,70+inset]],palette.gold,inset===0?2:1);
    for(const [x,y,flip]of [[72,97,false],[528,97,true],[72,685,false],[528,685,true]]){ctx.save();ctx.globalAlpha=.45;flourish(ctx,x,y,1.9,palette.line,flip);ctx.restore();}
    for(const [suitId,x,y]of [['spades',300,174],['diamonds',470,450],['clubs',300,726],['hearts',130,450]])suit(ctx,suitId,x,y,49,['hearts','diamonds'].includes(suitId)?palette.red:palette.ink);
  }else {
    for(const [x,y,flip]of [[74,72,false],[526,72,true],[74,210,false],[526,210,true]])flourish(ctx,x,y,2.3,palette.gold,flip);
    ctx.save();ctx.translate(WIDTH,HEIGHT);ctx.rotate(Math.PI);for(const [x,y,flip]of [[74,72,false],[526,72,true],[74,210,false],[526,210,true]])flourish(ctx,x,y,2.3,palette.gold,flip);ctx.restore();
    for(const y of [135,765])star(ctx,300,y,29,palette.gold,8,.18);
    for(const radius of [175,187,194]){ctx.beginPath();ctx.arc(300,450,radius,0,Math.PI*2);ctx.strokeStyle=palette.gold;ctx.lineWidth=radius===187?2:1;ctx.stroke();}
  }
  if(themeId==='adventure')compass(ctx,300,450,155,palette);
  else {
    const scale=themeId==='ivory'?1:1.1;
    ctx.save();ctx.translate(300,450);ctx.scale(scale,scale);ctx.beginPath();ctx.moveTo(-64,-75);ctx.lineTo(64,-75);ctx.lineTo(64,4);ctx.bezierCurveTo(63,60,22,88,0,102);ctx.bezierCurveTo(-22,88,-63,60,-64,4);ctx.closePath();ctx.fillStyle=palette.back;ctx.fill();ctx.strokeStyle=palette.gold;ctx.lineWidth=2;ctx.stroke();ctx.restore();
    compass(ctx,300,441,58,palette);
    for(const y of [300,600])star(ctx,300,y,17,palette.gold,4,.18);
  }
  ctx.restore();return canvas;
}

export function renderPreview(themeId,cards,back) {
  const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=1120;const ctx=canvas.getContext('2d');
  // Gallery labels belong to Translator's DOM catalog, never to baked bitmap text.
  ctx.fillStyle='#181d20';ctx.fillRect(0,0,canvas.width,canvas.height);
  const choices=[cards['A♠'],cards['K♥'],cards['Q♦'],cards['J♣'],cards['7♥'],back,cards['★ 1'],cards['★ 2']];
  for(const [index,card]of choices.entries()){const column=index%4,row=Math.floor(index/4);ctx.drawImage(card,48+column*344,78+row*496,312,468);}
  return canvas;
}

export function renderContactSheet(themeId,cards) {
  const specs=cardSpecs(),canvas=document.createElement('canvas');canvas.width=2160;canvas.height=2160;const ctx=canvas.getContext('2d');
  ctx.fillStyle='#181d20';ctx.fillRect(0,0,canvas.width,canvas.height);
  for(const [i,card]of specs.entries())ctx.drawImage(cards[card.name],20+(i%9)*238,20+Math.floor(i/9)*354,220,330);
  return canvas;
}

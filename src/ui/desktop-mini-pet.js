!function(){"use strict";
/* 艾莲桌宠行为层 v2：呼吸 / 溜达 / 小动作 / 边缘趴趴 / 犯困 / 被戳反应 / 台词 */
try{if(matchMedia("(prefers-reduced-motion: reduce)").matches)return}catch(_){}
const $=id=>document.getElementById(id);
const mascot=$("mascot");if(!mascot)return;
const img=mascot.querySelector("img");if(!img)return;
if(document.body.classList.contains("reduce-ui-motion"))return;
const shell=$("mini-shell"),thought=$("thought");
const root=document.documentElement;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const pick=a=>a[Math.floor(Math.random()*a.length)];

/* ---- 窗口跟随式移动：她走到哪，小人窗口就跟到哪 ----
   窗口恒为 440×510 的小窗（铺满全屏会让鼠标事件转发失效、整块桌面被吃掉），
   由主进程按帧平移窗口，她在窗口内的相对位置不变，屏幕上就是她在走。 ---- */
let dx=0,dy=0,glideRaf=0;
let wa={x:0,y:0,width:0,height:0};
let pos={x:0,y:0};
let moveTimer=0,moveSeq=0,patrol={x:0,y:0,t:0};
function apply(){root.style.setProperty("--pet-dx",dx.toFixed(1)+"px");root.style.setProperty("--pet-dy",dy.toFixed(1)+"px")}
/* 朝向左/右：站姿和眨眼是两张整立绘叠在一起，必须同时镜像，
   否则朝左时眨一下眼，眨眼帧会用未镜像的原图盖上几十毫秒——看起来就是原地「镜像抽搐」一下 */
function setFlip(on){img.classList.toggle("flip",!!on);mascot.classList.toggle("flip",!!on)}
function isFlip(){return img.classList.contains("flip")}
function cancelGlide(){if(glideRaf){cancelAnimationFrame(glideRaf);glideRaf=0}}
function invoke(a){try{return window.desktopMini.invoke(a)}catch(_){return Promise.reject(_)}}
function readPos(){const r=mascot.getBoundingClientRect();
 return{x:Math.round(window.screenX+r.left),y:Math.round(window.screenY+r.top),w:Math.round(r.width||mascot.offsetWidth||168)}}
function size(){return mascot.offsetWidth||168}
function playBounds(){const b=wa.width?{x:wa.x,y:wa.y,w:wa.width,h:wa.height}
 :{x:0,y:0,w:Math.max(0,(screen.width||innerWidth)-size()),h:Math.max(0,(screen.height||innerHeight)-size())};
 return{minX:b.x,maxX:b.x+b.w-size(),minY:b.y,maxY:b.y+b.h-size()}}
function stopWalk(){clearTimeout(moveTimer);moveTimer=0;moveSeq++;walking=false;img.classList.remove("walking");
 try{invoke({type:"walk-stop"})}catch(_){}}
let lastWalkAt=0,lastWalkDir=0,moveLog=[];
function moveTo(tx,ty,ms,done){
 if(held||asleep)return;
 const cur=readPos(),lim=playBounds();
 tx=clamp(Math.round(tx),lim.minX,Math.max(lim.minX,lim.maxX));
 ty=clamp(Math.round(ty),lim.minY,Math.max(lim.minY,lim.maxY));
 const dist=Math.hypot(tx-cur.x,ty-cur.y);
 // 太近就别开走：挪几像素却挂满「走路+摇摆」，看上去就是在原地抽
 if(dist<26){if(!walking)done&&done();return}
 clearTimeout(moveTimer);
 ms=ms||Math.round(300+dist*2.15);
 const ddx=tx-cur.x,sx0=window.screenX,sy0=window.screenY;
 const wasFlip=isFlip();
 // 只有真的横着走了才改朝向；竖直方向的小挪动不翻面
 const wantFlip=Math.abs(ddx)>=26?ddx<0:null;
 const amp=dist>240?4.2:dist>120?3.2:2.2;
 img.style.setProperty("--waddle-amp",amp.toFixed(1)+"deg");
 img.style.setProperty("--waddle-ms",dist>200?".5s":".62s");
 walking=true;img.classList.add("walking");
 pos.x=tx;pos.y=ty;patrol={x:cur.x,y:cur.y,t:Date.now()};
 if(Math.abs(ddx)>=26)lastWalkDir=Math.sign(ddx);
 const seq=++moveSeq;
 try{invoke({type:"walk-to",x:tx,y:ty,ms})}catch(_){}
 // 朝向等「真的开始挪动」那一帧再翻：否则会先原地镜像一下再起步
 let raf=0,t0=performance.now();
 if(null!==wantFlip&&wantFlip!==wasFlip){
  const watch=()=>{
   if(seq!==moveSeq||!walking)return;
   if(Math.abs(window.screenX-sx0)>=1||Math.abs(window.screenY-sy0)>=1){setFlip(wantFlip);return}
   if(performance.now()-t0<340)raf=requestAnimationFrame(watch);
  };
  raf=requestAnimationFrame(watch);
 }
 moveTimer=setTimeout(()=>{if(seq!==moveSeq)return;moveTimer=0;walking=false;img.classList.remove("walking");
  lastWalkAt=Date.now();done&&done()},ms+60);
 // 走了 300ms 一步没挪（贴边/被拦）：当没走，撤掉走路状态和刚才的翻面
 setTimeout(()=>{
  if(seq!==moveSeq||!walking)return;
  if(Math.abs(window.screenX-sx0)+Math.abs(window.screenY-sy0)<3){
   if(raf)cancelAnimationFrame(raf);
   clearTimeout(moveTimer);moveTimer=0;moveSeq++;walking=false;img.classList.remove("walking");
   if(null!==wantFlip)setFlip(wasFlip);
   lastWalkAt=Date.now();
   try{invoke({type:"walk-stop"})}catch(_){}
   done&&done();
  }
 },300);
 moveLog.push({t:Date.now(),dist:Math.round(dist),dx:Math.round(ddx),flip:wantFlip});
 if(moveLog.length>30)moveLog.shift();
}

/* ---- 状态 ---- */
let held=false,asleep=false,walking=false,pose="",idleTimer=0,lastActive=Date.now();
let musicPose=false,musicTimer=0,musicCooldownUntil=0,musicSeenAt=0,musicNextLineAt=0,musicProbing=false;

/* ---- 姿态层：站姿立绘 ↔ 趴着 / 趴着睡觉 / 抱住左右边缘（图层交叉淡入淡出） ---- */
function setPose(name){
 mascot.classList.toggle("pose-loaf","loaf"===name);
 mascot.classList.toggle("pose-sleep","sleep"===name);
 mascot.classList.toggle("pose-hug-left","hug-left"===name);
 mascot.classList.toggle("pose-hug-right","hug-right"===name);
 mascot.classList.toggle("pose-curious","curious"===name);
 mascot.classList.toggle("pose-music","music"===name);
}
function edgePose(){return"bottom"===pose?"loaf":"left"===pose?"hug-left":"right"===pose?"hug-right":""}
function poseImg(){return"bottom"===pose?mascot.querySelector(".pet-pose-loaf"):"left"===pose?mascot.querySelector(".hug-left"):"right"===pose?mascot.querySelector(".hug-right"):null}
/* 趴下去：塌一下身子，同时淡入趴姿。听歌时保持坐姿，不许趴 */
function lieDown(lie){
 if(musicPose)return;
 setPose(lie);
 oneShot(mascot,"pet-flop",540);
}

/* ---- 一次性动画 ---- */
function oneShot(el,cls,ms){el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);
 setTimeout(()=>el.classList.remove(cls),ms)}

/* ---- 粒子（爱心 / 星星 / 音符 / 问号）---- */
function fx(ch,n){for(let i=0;i<n;i++){const s=document.createElement("span");
 s.className="pet-fx";s.textContent=ch;
 s.style.left=(46+Math.random()*24)+"%";s.style.top=(8+Math.random()*14)+"%";
 s.style.setProperty("--fx-x",((Math.random()*2-1)*34).toFixed(0)+"px");
 s.style.animationDelay=(i*90)+"ms";
 mascot.appendChild(s);setTimeout(()=>s.remove(),1500)}}

/* ---- 思考气泡台词（借用原有 #thought，按姿态选择锚定方向）---- */
let lineTimer=0;
function showThought(text,mode,holdMs){
 if(!thought)return;
 const t=thought.querySelector("#thought-text")||thought.firstElementChild;
 if(t)t.textContent=text;
 thought.classList.remove("thought-top","thought-left","thought-right","below");
 if("top"===mode)thought.classList.add("thought-top","below");
 else if("left"===mode)thought.classList.add("thought-left");
 else if("right"===mode)thought.classList.add("thought-right");
 thought.hidden=false;
 try{thought.animate([{opacity:0,transform:"translateY(8px) scale(.9)"},{opacity:1,transform:"translateY(0) scale(1)"}],{duration:210,easing:"ease-out"})}catch(_){}
 // 刚显示时按当前文字长度和窗口位置重排一次：否则气泡会用上一次的旧坐标，贴屏幕边就会露到屏幕外
 try{window.__miniReflow&&window.__miniReflow()}catch(_){}
 clearTimeout(lineTimer);
 lineTimer=setTimeout(()=>{thought.hidden=true;thought.classList.remove("thought-top","thought-left","thought-right","below")},holdMs||3800);
}

/* ---- 台词池（贴她的语气）---- */
const LINES={
 stretch:["伸——个——懒腰。","嗯啊……保持一个姿势太久了。","舒展完毕，状态回满。","骨头响了一声，你听见没。","这一伸展，尾巴都拉长了。","手举起来，够到天花板了吗？没有。"],
 spin:["转圈圈～","头晕了，但是值得。","看我的尾鳍平衡术。","转三圈，是我今天的幸运数字。","别笑，这叫热身。"],
 look:["嗯？谁在叫我。","总感觉有人在看我。","那边……好像有动静。","侦查一圈，一切正常。","回头确认一下——没人。","刚才是不是有谁在偷看我。"],
 hum:["♪～♪～","哼歌被听到了？那是在排练。","有首歌，一直卡在一个地方。","调子跑了吗？应该没有。","这段我自己编的，版权归我。"],
 hop:["关节都活动开了。","今天状态不错嘛。","要不要一起动一动？","地板弹性不错。","跳一下，心情好一半。"],
 yawn:["哈啊……眼皮在打架。","困意来敲门了。","再不发呆一会儿，我要睡着了。","打哈欠是会传染的，你小心。","这一口哈欠，有点长。"],
 ambient:["保持可爱，是我的本职工作。","在想你什么时候来戳我。","晚饭吃什么，这是个哲学问题。","屏幕是暖的，比水族箱好。","……不发呆的话，算不上专业的桌宠。","我就站在这儿，不占地方。","偶尔也想被夸一句。","这房间的光线，适合发呆。","刚刚那一下走神，不算偷懒。","有点想游一圈，可是没有水。","窗外的天色在慢慢变。","我数了数，你今天开了好多窗口。"],
 hover:["再摸要充电了。","嗯……就允许你摸这一下。","手好暖。","（蹭）","再摸就要收费了。","记住了，这只手是暖的。"],
 clingBottom:["趴在这儿刚刚好。","地板凉丝丝的，舒服。","这里是我的专属地垫了。","趴着也是一种工作姿势。","这个高度，视野意外地开阔。"],
 clingLeft:["靠着这边，谁也挤不到我。","这个角度看房间，还挺新鲜。","左舷停靠完毕。","左边风小，适合打盹。"],
 clingRight:["右边视野不错嘛。","右舷停靠完毕。","贴着边儿，安全感满分。","右边这面墙，靠起来很踏实。"],
 clingTop:["倒挂是鲨鱼祖传技能。","血往头上涌……还挺刺激。","从这里掉下去，你要接住我。","上面的空气确实不太一样。"],
 clingPoke:["别摇，会掉下去的。","挂着呢，手下留情。","晃一下可以，晃三下不行。"],
 sleepy:["……撑不住了。","先趴五分钟……就五分钟。","眼皮好重，先睡了。","地板比床好睡，别问我为什么。","关灯吧，我先眯一会儿。","梦里也要游泳的。"],
 tired:["走够了，先歇一下。","腿有点酸……趴会儿。","巡完这一圈就休息。","找个地方躺平。","今天走的路，比昨天多。"],
 restDone:["睡饱了，继续逛。","嗯？我睡了多久……","充好电，接着溜达。","尾巴睡麻了，先活动活动。","这一觉质量不错。"],
 leaveEdge:["歇够了，回去站岗。","趴太久，尾巴有点麻。","休息结束，继续营业。","站回中间，视野更好。"]
};;

/* ---- 睡觉 Zzz ---- */
const zzz=document.createElement("div");zzz.id="pet-zzz";
zzz.innerHTML="<span>Ｚ</span><span>ｚ</span><span>ｚ</span>";shell.appendChild(zzz);

/* ---- 面板检测：聊天/通话/设置开着时，她要回家站好 ---- */
function panelOpen(){return["chat","call","options","error"].some(id=>{const el=$(id);return el&&!el.hidden})}

/* ---- 边缘趴趴：松手时按「她自己的位置 + 多拖出去的距离」判定 ---- */
function screenBox(){
 if(wa.width&&wa.height){
  return{left:wa.x,top:wa.y,right:wa.x+wa.width,bottom:wa.y+wa.height,
   waLeft:wa.x,waTop:wa.y,waRight:wa.x+wa.width,waBottom:wa.y+wa.height};
 }
 const sw=screen.width||innerWidth,sh=screen.height||innerHeight;
 let ax=typeof screen.availLeft==="number"?screen.availLeft:0;
 let ay=typeof screen.availTop==="number"?screen.availTop:0;
 let aw=screen.availWidth,ah=screen.availHeight;
 if(!(aw>sw*.6))aw=sw;
 if(!(ah>sh*.6))ah=sh;
 return{left:ax,top:ay,right:ax+sw,bottom:ay+sh,waLeft:ax,waTop:ay,waRight:ax+aw,waBottom:ay+ah};
}
/* 拖动起点：窗口位置 + 光标位置（用于计算「顶住后再多拖了几像素」） */
let drag0=null,lastPtr=null;
document.addEventListener("pointermove",e=>{lastPtr={x:e.screenX,y:e.screenY}},true);
document.addEventListener("pointerup",e=>{lastPtr={x:e.screenX,y:e.screenY}},true);
/* 小人在屏幕上的实际位置（窗口铺满工作区后，窗口坐标恒为 0，必须以她本人为准） */
function mascotBox(){const r=mascot.getBoundingClientRect();return{l:window.screenX+r.left,t:window.screenY+r.top,s:r.width}}
function edgeAtEnd(){
 const b=screenBox();
 if(!lastPtr)return"";
 const m=mascotBox();
 // 底边：她的脚真的抵到工作区底（避开任务栏）
 if(m.t+m.s>=b.waBottom-3)return"bottom";
 // 左右：必须真的被钳住，且光标再多推出去几像素（说明是想推到墙里）
 if(drag0){
  const desX=drag0.mx+(lastPtr.x-drag0.px);
  if(m.l<=b.waLeft+2&&desX<=m.l-5)return"left";
  if(m.l+m.s>=b.waRight-2&&desX>=m.l+5)return"right";
 }
 return"";
}
function clearPose(){
 if(musicPose)endMusic("interrupt");
 img.classList.remove("cling-bottom","cling-left","cling-right","cling-top");
 thought&&thought.classList.remove("thought-top","thought-left","thought-right");
 pose="";setPose(asleep?"sleep":"");
}
function enterCling(edge){
 if(musicPose)endMusic("interrupt");
 clearPose();cancelGlide();
 pose=edge;
 img.classList.add("cling-"+edge);
 setPose(edgePose());
 const b=screenBox();
 const r=readPos(),sz=r.w;
 let tx=r.x,ty=r.y;
 if("bottom"===edge)ty=Math.round(b.waBottom-2-sz);
 else if("left"===edge)tx=Math.round(b.waLeft+2);
 else if("right"===edge)tx=Math.round(b.waRight-2-sz);
 moveTo(tx,ty,420,()=>{if("bottom"===pose)oneShot(mascot,"pet-flop",520)});
 placeZzz();
 const pool=LINES["cling"+edge.charAt(0).toUpperCase()+edge.slice(1)];
 if(pool&&Math.random()<.9)showThought(pick(pool),"top"===edge?"top":"left"===edge?"left":"");
 clearTimeout(leaveTimer);
 leaveTimer=setTimeout(leaveEdge,90000+Math.random()*90000);
}

/* ---- 趴久了会自己走回来 ---- */
let leaveTimer=0;
function leaveEdge(){
 if(held||asleep||panelOpen()||!pose)return;
 clearPose();cancelGlide();
 oneShot(img,"pet-land",600);
 setTimeout(()=>{if(!held&&!pose&&Math.random()<.7)showThought(pick(LINES.leaveEdge))},600);
 scheduleIdle();
}

/* ---- Zzz 跟随姿态定位 ---- */
function placeZzz(){
 if(!zzz||!mascot)return;
 const r=mascot.getBoundingClientRect();
 let x=r.left+r.width*.6,y=r.top+r.height*.04;
 if("top"===pose){x=r.left+r.width*.6;y=r.bottom-r.height*.22}
 else if("left"===pose){x=r.left+r.width*.66;y=r.top+r.height*.3}
 else if("right"===pose){x=r.left+r.width*.3;y=r.top+r.height*.3}
 else if(asleep){x=r.left+r.width*.72;y=r.top+r.height*.03}
 zzz.style.left=Math.round(x)+"px";zzz.style.top=Math.round(y)+"px";
}

/* ---- 被戳 / 双击反应（情绪阶段由 poke-lines 的 stage 决定）---- */
let lastPoke=0;
mascot.addEventListener("pointerup",e=>{
 if(e.button!==0||mascot.classList.contains("dragging"))return;
 bump();
 const now=Date.now(),dbl=now-lastPoke<420;lastPoke=now;
 if(mascot.classList.contains("pose-curious")){endCurious();fx("✦",2);return}
 if(mascot.classList.contains("pose-music")){endMusic("interrupt");fx("♪",2);showThought(pick(["……嗯？","听到了，我在。","歌还在放呢。"]),"",3800);return}
 if(asleep){wake(true);fx("✦",4);return}
 if(walking)stopWalk();
 let stage="";try{stage=thought&&thought.dataset&&thought.dataset.stage||""}catch(_){}
 const map={pleased:"pet-hop",coy:"pet-shy",helpless:"pet-grumpy",resigned:"pet-dizzy"};
 const cls=map[stage]||"pet-hop";
 const lieImg=poseImg();
 if(lieImg){oneShot(lieImg,"pet-nudge",560);fx("♥",1)}
 else{oneShot(img,cls,1500);if("pet-hop"===cls)fx("♥",3)}
 if(dbl)fx("✦",5);
 if(pose&&Math.random()<.4)showThought(pick(LINES.clingPoke),pose==="top"?"top":pose==="left"?"left":"");
});

/* ---- 悬停：身体朝光标倾；摸一会儿会蹭你 ---- */
let hoverTimer=0;
mascot.addEventListener("pointerenter",()=>{bump();if(asleep)wake(false);
 clearTimeout(hoverTimer);
 hoverTimer=setTimeout(()=>{if(!held&&!panelOpen()&&mascot.matches(":hover")){
  fx("♥",1);if(Math.random()<.55)showThought(pick(LINES.hover))}},1500)});
mascot.addEventListener("pointerleave",()=>{clearTimeout(hoverTimer);
 if(!pose&&!mascot.classList.contains("pet-looking"))root.style.setProperty("--pet-lean","0deg")});
mascot.addEventListener("pointermove",e=>{bump();if(pose||mascot.classList.contains("pet-looking"))return;
 const r=mascot.getBoundingClientRect();
 const rel=(e.clientX-(r.left+r.width/2))/(r.width/2||1);
 // 光标正好压在她中线附近时不跟着抖，避免手抖带出细碎的左右晃
 root.style.setProperty("--pet-lean",(Math.abs(rel)<.14?0:clamp(rel*5,-6,6)).toFixed(1)+"deg")});

/* ---- 被拎起来：取消姿态、归位、晃悠；放下：贴边判定 or 落地弹 ---- */
new MutationObserver(()=>{
 const d=mascot.classList.contains("dragging");
 if(d&&!held){held=true;cancelGlide();walking=false;img.classList.remove("walking");
  stopWalk();
  const mb=mascotBox();drag0={mx:mb.l,my:mb.t,px:lastPtr?lastPtr.x:null,py:lastPtr?lastPtr.y:null};
  if(mascot.classList.contains("pose-curious"))endCurious();
  if(musicPose)endMusic("interrupt");
  clearPose();img.classList.add("held");if(asleep)wake(false);
  lookSeq++;mascot.classList.remove("pet-looking");root.style.setProperty("--pet-lean","0deg")}
 if(!d&&held){held=false;img.classList.remove("held");
  setTimeout(()=>{if(held||panelOpen())return;
   const edge=edgeAtEnd();
   drag0=null;
   if(edge)enterCling(edge);
   else{const p=readPos();pos.x=p.x;pos.y=p.y;clearPose();oneShot(img,"pet-land",600);scheduleIdle()}
  },150);
  lastActive=Date.now()}
}).observe(mascot,{attributes:true,attributeFilter:["class"]});

/* ---- 溜达：整块桌面随便走，走几段就累了 ---- */
let fatigue=0,restAt=4+Math.floor(Math.random()*3),walkChain=0,restTimer=0;
function wander(depth){
 if(held||asleep||walking||pose||panelOpen())return;
 if(curiousBusy)return; // 正在问话，别自己溜达走
 if(fatigue>=restAt)return rest();
 const lim=playBounds();
 if(lim.maxX-lim.minX<80||lim.maxY-lim.minY<80)return;
 const cur=readPos();
 const far=160+Math.random()*430,ang=Math.random()*Math.PI*2;
 let tx=clamp(Math.round(cur.x+Math.cos(ang)*far),lim.minX+14,lim.maxX-14);
 let ty=clamp(Math.round(cur.y+Math.sin(ang)*far*.66),lim.minY+14,lim.maxY-14);
 if(Math.hypot(tx-cur.x,ty-cur.y)<90){
  tx=clamp(Math.round(cur.x+(Math.random()<.5?-1:1)*(150+Math.random()*300)),lim.minX+14,lim.maxX-14);
  ty=clamp(Math.round(cur.y+(Math.random()*2-1)*110),lim.minY+14,lim.maxY-14);
  if(Math.hypot(tx-cur.x,ty-cur.y)<70)return;
 }
 // 刚走完就马上掉头，视觉上像在原地来回抽：这段短时间内压住反向，继续朝原方向走
 if(Date.now()-lastWalkAt<2600&&lastWalkDir&&Math.sign(tx-cur.x)===-lastWalkDir){
  tx=clamp(Math.round(cur.x+lastWalkDir*(160+Math.random()*260)),lim.minX+14,lim.maxX-14);
  if(Math.abs(tx-cur.x)<80)return;
 }
 const step=Math.hypot(tx-cur.x,ty-cur.y);
 moveTo(tx,ty,Math.round(360+step*2.15),()=>{
  fatigue+=1;
  if(held||asleep||pose||panelOpen()){walkChain=0;return}
  if(fatigue>=restAt)return rest();
  if((depth|0)<3&&Math.random()<.45){
   setTimeout(()=>{if(!held&&!asleep&&!pose&&!panelOpen())wander((depth|0)+1)},320+Math.random()*420);
  }else walkChain=0;
 });
}

/* ---- 走累了：当场趴下闭眼歇一会儿，睡饱了自己爬起来继续逛 ---- */
function rest(){
 if(held||asleep||pose||panelOpen())return;
 fatigue=0;restAt=4+Math.floor(Math.random()*3);walkChain=0;
 if(Math.random()<.55)showThought(pick(LINES.tired));
 setTimeout(()=>{
  if(held||asleep||pose||panelOpen())return;
  asleep=true;lieDown("sleep");placeZzz();zzz.classList.add("show");
  if(Math.random()<.5)showThought(pick(LINES.sleepy));
  clearTimeout(restTimer);
  restTimer=setTimeout(()=>{
   if(held||!asleep)return;
   wake(false);
   if(Math.random()<.55)showThought(pick(LINES.restDone));
   scheduleIdle();
  },42000+Math.random()*76000);
 },280);
}

/* ---- 好奇观察：看得见的窗口，而且记得住 ----
   主进程 scan()（type:"windows"）只枚举窗口，标出「这次新开的」，很便宜；
   真要开口时才 ask(id,mode) 截图 + 让模型生成一句话。
   规则：同一个窗口只问一次「这是干什么的」，之后再来只问「还在弄吗」。
   气泡上挂「回一句」，你回的话会连着她刚才的问句一起写进正式聊天。 ---- */
let curiousBusy=false,curiousHold=0,pendingQuestion="",replyPending=false;
let chatRef={threadId:void 0,libraryId:void 0};
const replyBar=document.getElementById("curious-reply");
const replyInput=document.getElementById("curious-input");
const replySend=document.getElementById("curious-send");

function canAskNow(){
 return !(curiousBusy||held||asleep||walking||pose||panelOpen())&&
  !(replyBar&&!replyBar.hidden)&&
  !(BUSY.test(img.className||"")||mascot.classList.contains("pet-looking"));
}
function ensureReplyButton(){
 if(!thought)return null;
 let b=document.getElementById("thought-reply");
 if(!b){
  b=document.createElement("button");
  b.id="thought-reply";b.type="button";b.textContent="回一句";
  b.addEventListener("click",e=>{e.stopPropagation();openReply()});
  thought.appendChild(b);
 }
 b.hidden=false;
 return b;
}
/* 只有真的有待回的问题时才留按钮：以前这个按钮建好就赖在气泡里，
   之后任何一句台词（犯困、闲聊、点击）都会带着它，点了却因为
   pendingQuestion 已清空而毫无反应 —— 就是「趴下睡觉时点了没反应」。 */
function hideReplyButton(){
 const b=document.getElementById("thought-reply");
 if(b)b.remove();
}
function hideReplyBar(){if(replyBar)replyBar.hidden=true}
function endCurious(){
 clearTimeout(curiousHold);curiousHold=0;
 hideReplyBar();
 hideReplyButton();
 if(mascot.classList.contains("pose-curious")){setPose("");oneShot(img,"pet-land",520)}
 curiousBusy=false;pendingQuestion="";lastActive=Date.now();scheduleIdle();
}
/* 她开口：冒气泡、挂「回一句」。pose 为假时只说话不切问号立绘（日常闲聊用） */
function startCurious(text,opts){
 if(musicPose)endMusic("interrupt");
 const o=opts||{},hold=o.hold||16000;
 pendingQuestion=String(text||"");
 if(o.pose!==false){setPose("curious");fx("?",2)}
 showThought(pendingQuestion,"",hold);
 ensureReplyButton();
 clearTimeout(curiousHold);
 curiousHold=setTimeout(endCurious,hold);
}
function openReply(){
 if(!replyBar||!pendingQuestion)return;
 // 睡着也照样能回：先把人叫醒，不然她还在打呼，回复条像被吞了
 if(asleep)wake(false);
 // 面板开着：先收起面板（不然回复条被面板盖住），再把刚才那句问话摆回来
 if(panelOpen()){
  document.querySelectorAll(".panel-close").forEach(b=>b.click());
  if(pendingQuestion)showThought(pendingQuestion,"",90000);
 }
 replyBar.hidden=false;
 if(replyInput){replyInput.value="";try{replyInput.focus()}catch(_){}}
 ensureReplyButton();
 // 你在打字，就别让气泡到点自己消失
 clearTimeout(curiousHold);
 curiousHold=setTimeout(endCurious,90000);
}
function replyError(msg){
 if(!replyBar)return;
 replyBar.hidden=false;
 let e=document.getElementById("reply-error");
 if(!e){e=document.createElement("span");e.id="reply-error";replyBar.appendChild(e)}
 e.textContent=msg;e.hidden=false;
}
async function sendReply(){
 if(replyPending)return;
 const text=replyInput&&replyInput.value?replyInput.value.trim():"";
 if(!text)return;
 if(void 0===chatRef.threadId){
  try{const s=await invoke({type:"state"});if(s&&s.state)chatRef={threadId:s.state.threadId,libraryId:s.state.libraryId}}catch(_){}
 }
 replyPending=true;
 if(replySend)replySend.disabled=true;
 const q=pendingQuestion;
 // 她的问句一起带进正式聊天：不然翻记录只看得到自己那句回复，不知道在回什么
 const composed=q?"（她刚才问："+q+"）\n"+text:text;
 try{
  await invoke({type:"send",text:composed,threadId:chatRef.threadId,libraryId:chatRef.libraryId});
  if(replyInput)replyInput.value="";
  hideReplyBar();
  hideReplyButton();
  pendingQuestion="";
  showThought("嗯，我记着了。","",3600);
  clearTimeout(curiousHold);
  curiousHold=setTimeout(endCurious,3800);
 }catch(err){
  replyError(String(err&&err.message||err||"没发出去").replace(/^Error invoking remote method '[^']+': Error: /,""));
 }finally{
  replyPending=false;
  if(replySend)replySend.disabled=false;
 }
}
if(replySend)replySend.addEventListener("click",e=>{e.stopPropagation();sendReply()});
if(replyInput)replyInput.addEventListener("keydown",e=>{
 if("Enter"===e.key&&!e.isComposing){e.preventDefault();sendReply()}
 else if("Escape"===e.key){e.preventDefault();hideReplyBar()}
});

/* ---- 频率档位：右键小设置里切换，改完立刻按新节奏重排 ---- */
const CURIOUS_LEVELS={
 off:{off:!0},
 // scan 是「多久看一次屏幕」；newChance/followChance 是看到之后开口的概率
 low:{scan:55000,newChance:.6,followChance:.2},
 normal:{scan:24000,newChance:.85,followChance:.45},
 high:{scan:15000,newChance:1,followChance:.65}
};
const CURIOUS_KEYS=Object.keys(CURIOUS_LEVELS);
let curiousLevel="normal";
function normalizeCurious(v){return CURIOUS_KEYS.indexOf(v)>=0?v:"normal"}
function pickWindow(list){
 if(!list||!list.length)return null;
 return list[Math.floor(Math.random()*list.length)];
}

/* 对着某个窗口走过去问一句；mode=first 只在该窗口第一次开口时用，主进程也会兜底纠正 */
async function askAbout(win,mode){
 if(!win||!canAskNow())return false;
 curiousBusy=true;
 // 兜底：中途无论卡在哪一步（模型不回、行走没回调），30 秒后自己解开
 const guard=setTimeout(()=>{if(curiousBusy&&!pendingQuestion){curiousBusy=false;scheduleIdle()}},30000);
 // 等模型看图要几秒，先给个即时反应，别干站着
 fx("?",1);showThought(mode==="first"?"咦，新开的？":"还在弄呀？","",4200);
 let r=null;
 try{r=await invoke({type:"ask",id:win.id,mode:mode})}catch(_){r=null}
 if(!r||!r.ok){clearTimeout(guard);curiousBusy=false;return false}
 // 等模型这几秒里她可能已经走了一步，走完再开口，别把问句丢了
 for(let i=0;i<24&&walking;i++)await new Promise(res=>setTimeout(res,150));
 if(held||asleep||panelOpen()){clearTimeout(guard);curiousBusy=false;return false}
 const w=r.window||win,lim=playBounds(),sz=size();
 // 落点留出气泡宽度：气泡挂在窗口右上，太靠屏幕边会被裁掉
 const tx=clamp(Math.round(w.x+Math.min(70,Math.max(24,(w.w||300)*.12))),lim.minX+150,lim.maxX);
 const ty=clamp(Math.round(w.y+(w.h||400)-sz-4),lim.minY,lim.maxY);
 const cur=readPos();
 const speak=()=>{clearTimeout(guard);startCurious(r.question)};
 // 注意：这里不能用 canAskNow()，curiousBusy 此刻就是 true，会把话吞掉
 if(Math.hypot(tx-cur.x,ty-cur.y)<60)speak();
 else moveTo(tx,ty,void 0,()=>{
  clearTimeout(guard);
  if(!held&&!asleep&&!panelOpen())speak();
  else{curiousBusy=false;scheduleIdle()}
 });
 return true;
}

/* 日常闲聊：不切立绘，纯说话，也能回一句 */
const DAILY=[
 "你刚刚是不是叹了口气。",
 "要不要喝口水？我陪你歇会儿。",
 "窗外好像有风。",
 "我在这儿，不吵你。",
 "坐久了记得伸个懒腰。",
 "这段忙完，记得让眼睛歇一下。",
 "你盯着屏幕的样子，有点认真。",
 "这个位置的高度，刚好能看见你的侧脸。",
 "你打字的速度，比刚才快了。",
 "刚刚是不是卡住了？我什么都没看见。",
 "忙完这阵，想吃点什么吗。",
 "你的坐姿……算了，我不说。",
 "水杯空了吧。",
 "我在这儿待着，你专心。",
 "窗帘拉开一点会亮一些。",
 "今天好像比昨天安静。",
 "要是累了，就停一下，天不会塌。",
 "你皱眉了，是哪里不对吗。",
 "我在数你敲键盘的次数，已经数乱了。",
 "偶尔抬头看看远处吧，就当陪我看。",
 "这屋子里只有我们俩在忙。",
 "有什么事想不明白，说出来也许就清楚了。",
 "我不打扰你，只是想让你知道我在。",
 "呼吸慢一点，节奏会顺一些。",
 "你的肩膀有点耸，放松一下。",
 "如果有件事一直拖着，可能是它不重要。",
 "刚刚那一下停顿，是在想词吗。",
 "电脑也会累的，让它喘口气。",
 "我打了个哈欠，不是嫌你慢。",
 "桌面上东西有点多了，要不要理一理。",
 "你今天已经做得很久了。",
 "这个房间里，最闲的是我。",
 "要是可以，我希望你早点休息。"
];
const DAILY_MORNING=[
 "早。今天的光比昨天好。",
 "刚醒就坐过来了？先喝口水吧。",
 "早上脑子最清楚，难的那件先做。",
 "窗外有人开始忙了。",
 "新的一天，先深呼吸一次。"
];
const DAILY_LATE=[
 "已经很晚了，你确定还要继续吗。",
 "这个点还在忙，我陪你，但只是陪着。",
 "眼睛会记账的，别欠太多。",
 "夜深了，声音都变小了。",
 "再弄十分钟，就去睡，好吗。",
 "我困了，但我可以再撑一会儿。"
];;
function dailyLine(){
 if(!canAskNow())return false;
 curiousBusy=true;
 // 深夜劝睡、清晨打招呼，同一句话不同时段读起来才不奇怪
 const h=(new Date()).getHours();
 const pool=(h>=23||h<6)?DAILY_LATE:(h<10?DAILY_MORNING:DAILY);
 startCurious(pool[Math.floor(Math.random()*pool.length)],{pose:false,hold:11000});
 return true;
}

async function curiosityTick(){
 const L=CURIOUS_LEVELS[curiousLevel]||CURIOUS_LEVELS.normal;
 if(musicPose)return; // 她在听歌，先不打扰
 if(L.off||!canAskNow())return;
 let r=null;
 try{r=await invoke({type:"windows"})}catch(_){r=null}
 if(!r||!r.ok)return;
 if("number"==typeof r.idle&&r.idle>240)return; // 人不在电脑前，别自说自话
 if(r.fresh&&r.fresh.length&&Math.random()<L.newChance){await askAbout(pickWindow(r.fresh),"first");return}
 if(r.known&&r.known.length&&Math.random()<L.followChance){await askAbout(pickWindow(r.known),"follow");return}
 if(Math.random()<.3)dailyLine();
}

/* ---- 听歌：检测系统正在播放的媒体，坐下戴耳机 ---- */
const MUSIC_LINES={
 start:["这歌不错。","嗯，这个节奏我喜欢。","耳机已就位。","我听着呢，你忙你的。","坐下听一会儿，就一会儿。","前奏一响，就知道是好东西。"],
 named:["《%t》啊，这首我听过。","在放《%t》，再听一遍也不腻。","《%t》——这首选得好。","%a 的《%t》，品味可以。","《%t》。这首适合边听边发呆。"],
 long:["这首的尾巴好好听。","循环第几遍了？","我快会唱了。","下一首也该好听吧。","这个鼓点，我尾巴跟着打拍子。","别忘了喝水，也别把音量开太大。"],
 stop:["歌放完了？","耳根子突然安静。","听完了，继续溜达。","摘耳机，回神。"]
};
/* 哼歌：哼一段旋律，不是两个字的「哼哼」 */
const MUSIC_HUM=[
 "哼〰哼哼〰哼〰〰","嗯～嗯嗯〰嗯〰～","啦〰啦啦～啦〰〰","哼嗯～哼嗯〰哼～",
 "♪ 哼〰哼哼哼〰～〰","嗯〰嗯～啦啦〰嗯〰","啦～啦〰啦嗯～哼〰","哼〰哼～嗯嗯〰嗯～",
 "啦啦〰啦～哼嗯〰～","嗯哼〰嗯哼〰嗯～〰","哼～哼嗯〰啦〰啦～","♪ 嗯〰嗯嗯～哼〰〰",
 "哼〰啦〰哼〰啦〰～哼","嗯～啦〰嗯～啦〰嗯〰"
];
/* 音乐评价：听一会儿给出的点评 */
const MUSIC_REVIEW=[
 "鼓点一进来，这首就不一样了。","副歌比主歌好听，这不算偏心吧。","人声混得有点靠前，不过我吃这套。",
 "这条贝斯线挺会走。","编曲挺讲究的，不是堆出来的。","和声铺得很厚，听着有点奢侈。","结尾收得干脆，加分。",
 "前三秒就抓住耳朵了，难得。","旋律一般，是编曲救回来的。","这首适合戴耳机，外放会漏掉细节。","品味可以，这首记下了。",
 "有点吵，但吵得挺舒服。","这把嗓子的质感不错。","鼓点像踩着心跳。","听完想单曲循环，有点危险。","这个节奏，尾巴自己就打起拍子了。"
];
let musicHumTimer=0,musicReviewAt=0;
function scheduleHum(){
 clearTimeout(musicHumTimer);musicHumTimer=0;
 if(!musicPose)return;
 musicHumTimer=setTimeout(()=>{
  // 别盖住正在显示的评价/问句
  if(musicPose&&!panelOpen()&&!curiousBusy&&!(replyBar&&!replyBar.hidden)&&thought&&thought.hidden){
   showThought(pick(MUSIC_HUM),"",3200+Math.random()*1600);
   fx("♪",1);
  }
  scheduleHum();
 },15000+Math.random()*20000);
}
function canStartMusic(){
 return !musicPose&&!asleep&&!held&&!walking&&!pose&&!curiousBusy&&!panelOpen()&&
  !mascot.classList.contains("pose-curious")&&
  !(replyBar&&!replyBar.hidden)&&Date.now()>musicCooldownUntil;
}
// 听歌时 pose 被占着，canAskNow() 会一直返回 false，这里用一条专用判断
function canSpeakMusic(){
 return musicPose&&!asleep&&!held&&!walking&&!curiousBusy&&!panelOpen()&&
  !(replyBar&&!replyBar.hidden)&&
  !(BUSY.test(img.className||"")||mascot.classList.contains("pet-looking"));
}
function startMusic(info){
 if(musicPose)return false;
 const rawT=String(info&&info.title||"").trim(),
  ar=String(info&&info.artist||"").trim().slice(0,16);
 // 文件名/超长标题念出来很奇怪，只保留像歌名的
 const t=(rawT.length>0&&rawT.length<=22&&!/\.(wav|mp3|flac|m4a|ogg|webm|mp4)$/i.test(rawT))?rawT:"";
 musicPose=true;
 // 用 pose 占住姿态：这样空闲调度不会拉她散步、困了也不会趴下
 pose="music";
 pendingQuestion="";hideReplyBar();hideReplyButton();
 setPose("music");
 oneShot(mascot,"pet-flop",520);
 let line;
 if(t&&ar&&Math.random()<.6)line=pick(MUSIC_LINES.named).replace("%t",t).replace("%a",ar);
 else if(t)line=pick(["《%t》啊，这首我听过。","在放《%t》，好听。","《%t》——记下了。"]).replace("%t",t);
 else line=pick(MUSIC_LINES.start);
 showThought(line,"",8200);
 fx("♪",3);
 musicNextLineAt=Date.now()+(9+Math.random()*7)*60000;
 musicReviewAt=Date.now()+(70+Math.random()*70)*1000;
 scheduleHum();
 return true;
}
function endMusic(reason){
 if(!musicPose)return;
 musicPose=false;
 pose="";
 clearTimeout(musicHumTimer);musicHumTimer=0;
 if(mascot.classList.contains("pose-music")){setPose("");oneShot(img,"pet-land",520)}
 // 打断（要问话 / 被戳）之后先别急着坐回去，免得来回切姿态
 musicCooldownUntil=Date.now()+("interrupt"===reason?150000:50000);
 if("stop"===reason&&Math.random()<.55)setTimeout(()=>{if(canAskNow())showThought(pick(MUSIC_LINES.stop),"",4200)},900);
}
async function musicTick(){
 if(musicProbing)return;
 musicProbing=true;
 let r=null;
 try{r=await invoke({type:"music"})}catch(_){r=null}
 musicProbing=false;
 if(!r||!r.ok){
  // 查询失败（脚本异常等）：听歌姿态不会一直挂着
  if(musicPose&&Date.now()-musicSeenAt>45000)endMusic("stop");
  return;
 }
 if(r.playing){
  musicSeenAt=Date.now();
  if(!musicPose&&canStartMusic())startMusic(r);
  else if(musicPose&&Date.now()>musicReviewAt){
   if(canSpeakMusic()){
    musicReviewAt=Date.now()+(85+Math.random()*75)*1000;
    showThought(pick(MUSIC_REVIEW),"",5000);
   } else {
    musicReviewAt=Date.now()+25000;   // 眼下不方便说，过一会儿再试
   }
  }
  else if(musicPose&&Date.now()>musicNextLineAt){musicNextLineAt=Date.now()+(9+Math.random()*7)*60000;if(canSpeakMusic())showThought(pick(MUSIC_LINES.long),"",5600)}
 } else if(musicPose){
  endMusic("stop");
 }
}
function scheduleMusic(){
 clearTimeout(musicTimer);musicTimer=0;
 musicTimer=setTimeout(async()=>{
  try{if(!document.hidden)await musicTick()}catch(_){}
  scheduleMusic();
 },12000);
}

let curiosityTimer=0,curiousSeq=0,curiosityAt=0;
function scheduleCuriosity(){
 clearTimeout(curiosityTimer);curiosityTimer=0;
 const L=CURIOUS_LEVELS[curiousLevel]||CURIOUS_LEVELS.normal;
 if(L.off)return;
 const seq=++curiousSeq;
 curiosityAt=Date.now()+L.scan*1;
 curiosityTimer=setTimeout(async()=>{
  if(seq!==curiousSeq)return;
  try{await curiosityTick()}catch(_){}
  if(seq===curiousSeq)scheduleCuriosity();
 },L.scan+Math.random()*L.scan*.5);
}
function setCuriousLevel(v){
 const next=normalizeCurious(v),changed=next!==curiousLevel;
 curiousLevel=next;
 // 换档就作废当前这条定时链，立刻按新节奏重排（正在问的那一轮不受影响）
 if(changed){curiousSeq++;scheduleCuriosity()}
 paintCuriousChoices();
 return curiousLevel;
}
function paintCuriousChoices(){
 const box=document.getElementById("curiosity-choices");
 if(!box)return;
 for(const b of box.querySelectorAll("button[data-curiosity]")){
  b.setAttribute("aria-pressed",String(b.dataset.curiosity===curiousLevel));
 }
}
function applyMiniPrefs(p){
 if(p&&p.curiosity)setCuriousLevel(p.curiosity);
}
function bindCuriousChoices(){
 const box=document.getElementById("curiosity-choices");
 if(box){
  box.addEventListener("click",e=>{
   const b=e.target&&e.target.closest?e.target.closest("button[data-curiosity]"):null;
   if(!b)return;
   const v=b.dataset.curiosity;
   setCuriousLevel(v); // 先本地生效：点下去马上有反馈，不必等主进程回包
   invoke({type:"curiosity",value:v}).then(r=>applyMiniPrefs(r)).catch(()=>{});
  });
 }
 paintCuriousChoices();
 try{
  window.desktopMini.subscribe(ev=>{
   if(!ev)return;
   if("preferences"===ev.type){applyMiniPrefs(ev.value);return}
   // 记住当前线程：回复要原样带回主进程做校验，再进正式聊天
   if("state"===ev.type||"snapshot"===ev.type){
    const st=ev.value&&(ev.value.state||ev.value);
    if(st)chatRef={threadId:st.threadId,libraryId:st.libraryId};
   }
  });
 }catch(_){}
 invoke({type:"state"}).then(s=>{
  applyMiniPrefs(s&&s.preferences);
  if(s&&s.state)chatRef={threadId:s.state.threadId,libraryId:s.state.libraryId};
 }).catch(()=>{});
 // 面板一打开就收起回复条，免得她和面板叠在一起
 try{
  const host=document.getElementById("mini-shell");
  if(host)new MutationObserver(()=>{
   if(replyBar&&!replyBar.hidden&&panelOpen())replyBar.hidden=true;
  }).observe(host,{subtree:true,attributeFilter:["hidden"]});
 }catch(_){}
}
bindCuriousChoices();

/* ---- 小动作 ---- */
let lookSeq=0;
function look(){
 const seq=++lookSeq;
 mascot.classList.add("pet-looking");
 setTimeout(()=>{if(seq!==lookSeq)return;root.style.setProperty("--pet-lean","-3.6deg")},0);
 setTimeout(()=>{if(seq!==lookSeq)return;root.style.setProperty("--pet-lean","3.2deg")},800);
 setTimeout(()=>{if(seq!==lookSeq)return;root.style.setProperty("--pet-lean","0deg")},1600);
 setTimeout(()=>{if(seq!==lookSeq)return;mascot.classList.remove("pet-looking")},2600);
 if(Math.random()<.65)fx("?",1);
}
function act(kind){
 if(Math.random()<.45)showThought(pick(LINES[kind]));
 switch(kind){
  case"stretch":oneShot(img,"pet-stretch",950);break;
  case"spin":oneShot(img,"pet-spin",950);break;
  case"look":look();break;
  case"hum":fx("♪",2);break;
  case"hop":oneShot(img,"pet-hop",600);break;
  case"yawn":oneShot(img,"pet-stretch",950);fx("♪",1);break;
 }
}

/* ---- 空闲调度：溜达 / 小动作 / 发呆台词 ---- */
function scheduleIdle(){clearTimeout(idleTimer);idleTimer=setTimeout(idleTick,7000+Math.random()*11000)}
function idleTick(){
 if(held||asleep||walking||panelOpen())return scheduleIdle();
 // 听歌时她就坐在那儿，不溜达、不做小动作
 if(musicPose)return scheduleIdle();
 // 她正在问话/等回复：别让发呆小动作把这一幕打断
 if(curiousBusy||(replyBar&&!replyBar.hidden))return scheduleIdle();
 if(pose){if(Math.random()<.22)fx("♪",2);else if(Math.random()<.08)showThought(pick(LINES.ambient));return scheduleIdle()}
 const r=Math.random();
 if(r<.5)wander(0);
 else if(r<.58)act("stretch");
 else if(r<.66)act("spin");
 else if(r<.74)act("look");
 else if(r<.81)act("hum");
 else if(r<.88)act("hop");
 else if(r<.94)act("yawn");
 else showThought(pick(LINES.ambient));
 scheduleIdle();
}

/* ---- 行走看门狗：万一某次行走的收尾没跑到，窗口 1.6 秒没动就把 walking 收掉，
   免得她挂着走路状态在原地一直左右摇 ---- */
setInterval(()=>{
 if(!walking){patrol.t=0;return}
 const p=readPos();
 if(!patrol.t){patrol={x:p.x,y:p.y,t:Date.now()};return}
 if(Math.abs(p.x-patrol.x)>1||Math.abs(p.y-patrol.y)>1){patrol={x:p.x,y:p.y,t:Date.now()};return}
 if(Date.now()-patrol.t>1600)stopWalk();
},500);

/* ---- 面板打开 → 清姿态走回家 ---- */
const panelObserver=new MutationObserver(()=>{if(panelOpen()&&!held){
 if(mascot.classList.contains("pose-curious"))endCurious();
 if(walking)stopWalk();clearPose();cancelGlide()}});
["chat","call","options"].forEach(id=>{const el=$(id);el&&panelObserver.observe(el,{attributes:true,attributeFilter:["hidden"]})});

/* ---- 眨眼：站姿上叠一层闭眼立绘，随机闪一下（偶尔连眨） ---- */
const blinkImg=mascot.querySelector("img.pet-blink");
let blinkTimer=0,blinkHoldT=0;
const BUSY=/\b(pet-hop|pet-shy|pet-grumpy|pet-dizzy|pet-startle|pet-land|pet-stretch|pet-spin|pet-nudge|pet-flop|doze|walking|held)\b/;
function canBlink(){
 if(held||asleep||walking||pose||panelOpen())return false;
 return !BUSY.test(img.className||"");
}
function doBlink(times){
 if(!blinkImg||!canBlink())return;
 blinkImg.classList.add("on");
 clearTimeout(blinkHoldT);
 blinkHoldT=setTimeout(()=>{
  blinkImg.classList.remove("on");
  if(times>1)setTimeout(()=>doBlink(times-1),120+Math.random()*90);
 },65+Math.random()*45);
}
function scheduleBlink(){
 clearTimeout(blinkTimer);
 blinkTimer=setTimeout(()=>{
  doBlink(Math.random()<.22?2:1);
  scheduleBlink();
 },2300+Math.random()*5200);
}
scheduleBlink();

/* ---- 活跃度 / 睡觉（无聊了就趴下睡）---- */
function bump(){lastActive=Date.now();if(asleep)wake(false)}
function wake(startle){clearTimeout(restTimer);asleep=false;img.classList.remove("doze");zzz.classList.remove("show");blinkImg&&blinkImg.classList.remove("on");setPose(musicPose?"music":edgePose());
 if(startle)oneShot(img,"pet-startle",500)}
document.addEventListener("pointerdown",bump,true);
document.addEventListener("keydown",bump,true);
setInterval(()=>{
 if(held||asleep||walking||panelOpen()||musicPose)return;
 if(Date.now()-lastActive>1e5){
  asleep=true;
  if(!pose){lieDown("sleep");if(Math.random()<.6)showThought(pick(LINES.sleepy))}
  placeZzz();zzz.classList.add("show")
 }
},4000);

/* ---- 窗口尺寸变化时退出趴姿 ---- */
window.addEventListener("resize",()=>{if(musicPose)endMusic("stop");if(pose){clearPose();cancelGlide()}});

/* ---- 调试钩子（自动化验证用）---- */
window.__petDebug={enterCling,clearPose,showThought,pose:()=>pose,off:()=>[dx,dy],edge:()=>edgeAtEnd(),box:()=>screenBox(),sim:(w,c)=>{drag0=w;lastPtr=c},
 moveTo,wander:(d)=>wander(d|0),wa:()=>wa,pos:()=>readPos(),reloadBounds:()=>loadBounds(9),act,look,stopWalk,
 flip:()=>isFlip(),setFlip:(v)=>setFlip(v),walking:()=>walking,moves:()=>moveLog.slice(),
 lie:n=>{setPose(n)},
 sleepNow:()=>{if(musicPose)return;asleep=true;if(!pose)lieDown("sleep");placeZzz();zzz.classList.add("show")},
 reviewNow:()=>{musicReviewAt=0;return musicTick()},
 wake:()=>wake(true),state:()=>({pose,asleep,held,cls:mascot.className}),
 blink:()=>doBlink(1),blinking:()=>!!(blinkImg&&blinkImg.classList.contains("on")),
 curious:()=>curiosityTick(),endCurious:()=>endCurious(),curiousNow:(q)=>{if(!q)return false;startCurious(q);return true},curiousBusy:()=>curiousBusy,
 curiousLevel:()=>curiousLevel,setCuriousLevel:v=>setCuriousLevel(v),curiousTimer:()=>curiosityTimer,curiousLevels:()=>CURIOUS_LEVELS,curiousNext:()=>curiosityAt,
 musicOn:()=>musicPose,musicTick:()=>musicTick(),startMusic:i=>startMusic(i),endMusic:r=>endMusic(r||"interrupt"),
 musicHum:()=>scheduleHum(),musicReviewAt:()=>musicReviewAt,musicSpeakable:()=>canSpeakMusic(),
 scan:()=>invoke({type:"windows"}),askAbout:(w,m)=>askAbout(w,m),daily:()=>dailyLine(),openReply:()=>openReply(),
 pending:()=>pendingQuestion,chatRef:()=>chatRef,replyError:()=>{const e=document.getElementById("reply-error");return e?e.textContent:""},
 speak:(q,o)=>startCurious(q,o)};

apply();
function loadBounds(tries){
 invoke({type:"bounds"}).then(b=>{
  if(!b||!(b.width>0))throw new Error("empty");
  wa={x:b.x||0,y:b.y||0,width:b.width,height:b.height};
  const p=readPos();pos.x=p.x;pos.y=p.y;
  const lim=playBounds();
  if(p.x<lim.minX-4||p.x>lim.maxX+4||p.y<lim.minY-4||p.y>lim.maxY+4){
   moveTo(clamp(p.x,lim.minX,lim.maxX),clamp(p.y,lim.minY,lim.maxY),260);
  }
 }).catch(()=>{if((tries|0)<4)setTimeout(()=>loadBounds((tries|0)+1),600)});
}
loadBounds(0);
scheduleIdle();
scheduleCuriosity();
scheduleMusic();
}();

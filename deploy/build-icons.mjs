// One geometric source for the SVG and dependency-free, antialiased PNG exports.
// The cut-corner G suggests a processor; the detached blue node suggests observation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const dir=fileURLToPath(new URL('../public/icons/',import.meta.url));mkdirSync(dir,{recursive:true});
const background=[12,20,32],mint=[142,227,180],blue=[120,188,255];
const points=[[344,152],[312,120],[200,120],[120,200],[120,312],[200,392],[312,392],[392,312],[392,264],[272,264]];
const stroke=40,node={x:392,y:152,r:20};
const path=points.map(([x,y],i)=>(i?'L':'M')+x+' '+y).join(' ');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">GPU Observatory</title>
  <desc id="desc">A mint processor-shaped G and a blue observation node on a dark navy tile.</desc>
  <rect width="512" height="512" rx="112" fill="#0c1420"/>
  <path d="${path}" fill="none" stroke="#8ee3b4" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${node.x}" cy="${node.y}" r="${node.r}" fill="#78bcff"/>
</svg>\n`;
writeFileSync(dir+'icon.svg',svg);
const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);};
const segments=points.slice(1).map((b,i)=>{const a=points[i],dx=b[0]-a[0],dy=b[1]-a[1];return {x:a[0],y:a[1],dx,dy,length:dx*dx+dy*dy};});
function inMark(x,y){
  for(const line of segments){const t=Math.max(0,Math.min(1,((x-line.x)*line.dx+(y-line.y)*line.dy)/line.length));if((x-line.x-t*line.dx)**2+(y-line.y-t*line.dy)**2<=(stroke/2)**2)return true;}
  return false;
}
function render(size,maskable){
  const raw=Buffer.alloc((size*4+1)*size),samples=4,total=samples*samples;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let alpha=0;const sum=[0,0,0];
    for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){
      const u=(x+(sx+.5)/samples)*512/size,v=(y+(sy+.5)/samples)*512/size;
      const cx=Math.max(112,Math.min(400,u)),cy=Math.max(112,Math.min(400,v));
      if(!maskable&&(u-cx)**2+(v-cy)**2>112**2)continue;
      const color=(u-node.x)**2+(v-node.y)**2<=node.r**2?blue:inMark(u,v)?mint:background;
      alpha++;for(let channel=0;channel<3;channel++)sum[channel]+=color[channel];
    }
    const offset=y*(size*4+1)+1+x*4;
    for(let channel=0;channel<3;channel++)raw[offset+channel]=alpha?Math.round(sum[channel]/alpha):0;
    raw[offset+3]=Math.round(alpha/total*255);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
// Essential artwork fits in the central 80%-diameter safe circle. Maskable exports
// have an opaque full-bleed background so OS masks cannot expose empty corners.
for(const [name,size,mask] of [['app-192.png',192,false],['app-512.png',512,false],['app-maskable-512.png',512,true],['apple-touch-icon.png',180,true]])writeFileSync(dir+name,render(size,mask));
console.log('Built SVG, 192px, 512px, maskable and Apple touch icons.');

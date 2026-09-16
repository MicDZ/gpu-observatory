// Deterministic raster/vector versions of the existing mint G mark; no dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const dir=fileURLToPath(new URL('../public/icons/',import.meta.url));mkdirSync(dir,{recursive:true});
const crc=b=>{let c=0xffffffff;for(const n of b){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);};
function render(size,maskable){
  const raw=Buffer.alloc((size*4+1)*size),samples=4;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let alpha=0,dark=0;
    for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){
      const u=(x+(sx+.5)/samples)*512/size,v=(y+(sy+.5)/samples)*512/size;
      const cx=Math.max(102,Math.min(410,u)),cy=Math.max(102,Math.min(410,v));
      const inside=maskable||(u-cx)**2+(v-cy)**2<=102**2;
      if(!inside)continue;alpha++;
      const dx=u-256,dy=v-256,r=Math.hypot(dx,dy),angle=Math.atan2(dy,dx)*180/Math.PI;
      const ring=r>=100&&r<=160&&!(angle>-45&&angle<35);
      const bar=u>=256&&u<=413&&v>=236&&v<=294;
      const stem=u>=355&&u<=413&&v>=258&&v<=347;
      if(ring||bar||stem)dark++;
    }
    const offset=y*(size*4+1)+1+x*4,f=alpha?dark/alpha:0;
    for(const [i,a,b] of [[0,142,20],[1,227,37],[2,180,27]])raw[offset+i]=Math.round(a*(1-f)+b*f);
    raw[offset+3]=Math.round(alpha/(samples*samples)*255);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
for(const [name,size,mask] of [['app-192.png',192,false],['app-512.png',512,false],['app-maskable-512.png',512,true],['apple-touch-icon.png',180,true]])writeFileSync(dir+name,render(size,mask));
writeFileSync(dir+'icon.svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="102" fill="#8ee3b4"/><path d="M369 143 A160 160 0 1 0 387 348 L338 313 A100 100 0 1 1 327 185 Z" fill="#14251b"/><path d="M256 236H413V347H355V294H256Z" fill="#14251b"/></svg>\n');
console.log('Built 192px, 512px, maskable, Apple touch and SVG icons.');

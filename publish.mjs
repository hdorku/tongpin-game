import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
let html=readFileSync('dist/dev.html','utf8');
html=html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g,(_,src)=>{
 const js=readFileSync(resolve('dist',src.replace(/^\.\//,'')),'utf8').replace(/<\/script/gi,'<\\/script');
 return `<script type="module">${js}</script>`;
});
html=html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,(_,src)=>`<style>${readFileSync(resolve('dist',src.replace(/^\.\//,'')),'utf8')}</style>`);
writeFileSync('dist/index.html',html);writeFileSync('index.html',html);
console.log('Standalone GitHub Pages index.html:',Buffer.byteLength(html),'bytes');

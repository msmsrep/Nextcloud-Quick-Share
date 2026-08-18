// ストア用アセットのビルド専用サーバー（同一オリジンで src/ と icon/ を出す）
const http=require("http"),fs=require("fs"),path=require("path");
const ROOT=path.join(__dirname,"..","..");
const T={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png"};
const send=(r,s,t,b)=>{r.writeHead(s,{"Content-Type":t,"Cache-Control":"no-store"});r.end(b);};

http.createServer((q,r)=>{
  if(q.method==="POST"&&q.url==="/save"){
    let b="";q.on("data",c=>b+=c);
    q.on("end",()=>{
      try{
        const data=JSON.parse(b),out=[];
        for(const [name,d] of Object.entries(data)){
          const buf=Buffer.from(d.png,"base64");
          if(buf.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")throw new Error(name+": bad PNG");
          const w=buf.readUInt32BE(16),h=buf.readUInt32BE(20);
          if(w!==d.w||h!==d.h)throw new Error(`${name}: ${w}x${h} (expected ${d.w}x${d.h})`);
          fs.writeFileSync(path.join(ROOT,"store",name),buf);
          out.push(`${name} ${w}x${h} ${buf.length}B`);
        }
        console.log(out.join("\n"));
        send(r,200,"text/plain; charset=utf-8",out.join("\n"));
      }catch(e){console.error(e.message);send(r,500,"text/plain; charset=utf-8",e.message);}
    });
    return;
  }

  let n=decodeURIComponent(q.url.split("?")[0]).replace(/^\/+/,"")||"build.html";
  // ポップアップ本体はスタブを差し込んで配信（test/ui と同じ方式）
  if(n==="popup.html"){
    const html=fs.readFileSync(path.join(ROOT,"src","popup.html"),"utf8");
    const injected=html.replace('<script src="uploader.js"></script>','<script src="chrome-stub.js"></script>\n    <script src="uploader.js"></script>');
    if(injected===html)return send(r,500,T[".html"],"uploader.js の script タグが見つかりません");
    return send(r,200,T[".html"],injected);
  }
  const candidates=[path.join(__dirname,n),path.join(ROOT,"test","ui",n),path.join(ROOT,"src",n),path.join(ROOT,n)];
  const f=candidates.find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
  if(!f)return send(r,404,"text/plain","404 "+n);
  send(r,200,T[path.extname(f)]||"text/plain",fs.readFileSync(f));
}).listen(8733,()=>console.log("store asset builder on 8733"));

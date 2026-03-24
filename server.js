const http=require("http");
const port=process.env.PORT||3000;
http.createServer((q,s)=>{
  s.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
  s.end("<h1>Aminoglu.bet</h1><p>Server calisiyor</p>");
}).listen(port,()=>console.log("running "+port));

import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import crypto from 'node:crypto';

const result = data => ({content:[{type:'text',text:JSON.stringify(data)}],details:data});
export function serverTools(getManager, getDefault) {
  const resolve = id => {
    const manager = getManager();
    const target = id || getDefault();
    const server = manager?.list().find(row => row.id === target);
    if (!server) throw Error('服务器不存在，请先调用 servers_list 获取准确的 serverId');
    return {manager,server};
  };
  return [{name:'servers_list',label:'服务器列表',description:'查询用户已添加的服务器及准确 ID，不含登录凭据。current 标记本会话默认服务器。',parameters:{type:'object',properties:{}},
    execute:async()=>result({servers:(getManager()?.list() || []).map(({id,name,host,port,username,connected})=>({id,name,host,port,username,connected,current:id===getDefault()}))})},
  {name:'ssh_exec',label:'服务器命令',description:'在指定服务器执行命令。serverId 省略时使用会话默认服务器；跨服务器任务先查询 servers_list 并明确指定 ID。每次是独立 shell，请指定 cd。',
    parameters:{type:'object',properties:{serverId:{type:'string',description:'servers_list 返回的服务器 ID'},command:{type:'string',description:'远程 shell 命令'}},required:['command']},
    execute:async(_id,args,signal)=>{
      if(typeof args.command !== 'string' || !args.command.trim()) throw Error('命令不能为空');
      const {manager,server}=resolve(args.serverId);
      const reply=await manager.exec(server.id,args.command,signal);
      return result({serverId:server.id,serverName:server.name,exitCode:reply.code,output:reply.output});
    }},
  {name:'server_copy_file',label:'跨服务器传输',description:'通过本机 SSH 连接中转单个普通文件，无需服务器互相登录。不覆盖已有目标；请传到新的暂存路径，再检查差异、备份并部署。不要用源服务器配置、数据库覆盖目标数据。单文件上限 64 MiB。',
    parameters:{type:'object',properties:{sourceServerId:{type:'string'},targetServerId:{type:'string'},sourcePath:{type:'string'},targetPath:{type:'string'}},required:['sourceServerId','targetServerId','sourcePath','targetPath']},
    execute:async(_id,args,signal)=>{
      const source=resolve(args.sourceServerId), target=resolve(args.targetServerId);
      if (!args.sourceServerId || !args.targetServerId) throw Error('传输必须明确指定来源和目标服务器');
      const info=await copyServerFile(source.manager,{...args},signal);
      return result({...info,sourceServerName:source.server.name,targetServerName:target.server.name});
    }}];
}
export async function copyServerFile(manager, args, signal) {
  for(const value of [args.sourcePath,args.targetPath]) if(typeof value!=='string' || !value.startsWith('/') || value.includes('\0') || value.endsWith('/')) throw Error('请指定远程文件的绝对路径');
  if(args.sourceServerId===args.targetServerId && args.sourcePath===args.targetPath) throw Error('来源与目标不能相同');
  signal?.throwIfAborted();
  await Promise.all([manager.connect(args.sourceServerId),manager.connect(args.targetServerId)]);
  signal?.throwIfAborted();
  const channels=[];
  const open=id=>new Promise((resolve,reject)=>{
    const client=manager.clients.get(id);
    if(!client) return reject(Error('服务器已断开连接'));
    client.sftp((error,sftp)=>{if(error) reject(error);else {channels.push(sftp);resolve(sftp);}});
  });
  const call=(sftp,method,...values)=>new Promise((resolve,reject)=>sftp[method](...values,(error,value)=>error?reject(error):resolve(value)));
  let target, temporary, created=false;
  try {
    const opened=await Promise.allSettled([open(args.sourceServerId),open(args.targetServerId)]);
    const failure=opened.find(item=>item.status==='rejected'); if(failure) throw failure.reason;
    const source=opened[0].value; target=opened[1].value;
    signal?.throwIfAborted();
    const stat=await call(source,'lstat',args.sourcePath);
    if(!stat.isFile() || stat.size>64*1024*1024) throw Error('仅支持不超过 64 MiB 的普通文件');
    try {await call(target,'lstat',args.targetPath);throw Error('目标文件已存在，请使用新的暂存路径');} catch(error) {if(error.code!==2) throw error;}
    temporary=args.targetPath+'.halo-'+crypto.randomUUID()+'.tmp';
    let bytes=0;
    const hash=crypto.createHash('sha256');
    const meter=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;if(bytes>64*1024*1024)return done(Error('文件超出 64 MiB'));hash.update(chunk);done(null,chunk);}});
    const output=target.createWriteStream(temporary,{flags:'wx',mode:0o600});
    output.on('open',()=>{created=true;});
    await pipeline(source.createReadStream(args.sourcePath),meter,output,{signal});
    if(bytes!==stat.size) throw Error('来源文件在传输期间发生变化，请重试');
    signal?.throwIfAborted();
    // Standard SFTP rename refuses an existing target; do not use posix-rename overwrite.
    await call(target,'rename',temporary,args.targetPath); created=false;
    return {...args,bytes,sha256:hash.digest('hex')};
  } finally {
    if(created) await call(target,'unlink',temporary).catch(()=>{});
    for(const channel of channels) channel.end();
  }
}

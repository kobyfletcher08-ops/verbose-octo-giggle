import { isAddress, getAddress, ZeroAddress, verifyTypedData, verifyAuthorization, keccak256, Interface } from 'ethers';
export const ABI = [
  'function rescue(address token,address destination,uint256 minAmount,uint256 nonce,uint256 deadline,bytes signature)',
  'function alreadyUsed(uint256 nonce) view returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];
export const IFACE = new Interface(ABI);
export const TYPES = {Rescue:[
  {name:'token',type:'address'}, {name:'destination',type:'address'},
  {name:'minAmount',type:'uint256'}, {name:'nonce',type:'uint256'},
  {name:'deadline',type:'uint256'}
]};
const hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export function asUInt(v, label, positive=false){
  if(typeof v!=='string' && typeof v!=='number' && typeof v!=='bigint')throw Error(`${label}: numeric value required`);
  const s=String(v);if(!/^(0|[1-9][0-9]*)$/.test(s))throw Error(`${label}: nonnegative integer required`);
  const x=BigInt(s);if(x>=(1n<<256n)||(positive&&x===0n))throw Error(`${label}: out of bounds`);return x;
}
export function parseHttps(url){
  let u;try{u=new URL(url)}catch{throw Error('Invalid URL')}
  if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('RPC must be HTTPS, without URL credentials or fragment');
  if(/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$)/i.test(u.hostname))throw Error('Private and local RPC hosts are disallowed');
  if(u.port && u.port!=='443')throw Error('Use an HTTPS RPC with standard port 443');
  return u.toString();
}
export function checkPackage(p){
  if(!p||Array.isArray(p)||typeof p!=='object'||p.version!==1)throw Error('Unsupported package version');
  if(!p.auth||!p.rescue||typeof p.auth!=='object'||typeof p.rescue!=='object')throw Error('Missing signatures');
  if(!isAddress(p.owner)||!isAddress(p.delegate)||!isAddress(p.rescue.token)||!isAddress(p.rescue.destination))throw Error('Invalid address');
  if(getAddress(p.owner)===getAddress(p.rescue.destination))throw Error('Rescue destination must be a different wallet');
  if(!/^0x[0-9a-fA-F]{64}$/.test(p.delegateCodeHash))throw Error('Missing delegate bytecode hash');
  const chainId=asUInt(p.chainId,'chainId',true), nonce=asUInt(p.rescue.nonce,'nonce');
  const deadline=asUInt(p.rescue.deadline,'deadline',true), minAmount=asUInt(p.rescue.minAmount,'minAmount',true);
  const authNonce=asUInt(p.auth.nonce,'auth.nonce');
  if(authNonce>=(1n<<64n))throw Error('Authorization nonce exceeds EIP-7702 bound');
  if(asUInt(p.auth.chainId,'auth.chainId')!==chainId)throw Error('Authorization is not chain-scoped');
  if(getAddress(p.auth.address)!==getAddress(p.delegate))throw Error('Authorization delegate mismatch');
  if(typeof p.auth.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(p.auth.signature))throw Error('Bad authorization signature');
  if(typeof p.rescue.signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(p.rescue.signature))throw Error('Bad rescue signature');
  const recoveredAuth=verifyAuthorization({address:p.delegate,nonce:authNonce,chainId},p.auth.signature);
  const value={token:p.rescue.token,destination:p.rescue.destination,minAmount,nonce,deadline};
  const recovered=verifyTypedData({name:'SelfRescue7702',version:'1',chainId,verifyingContract:p.owner},TYPES,value,p.rescue.signature);
  if(getAddress(recoveredAuth)!==getAddress(p.owner)||getAddress(recovered)!==getAddress(p.owner))throw Error('Signatures do not belong to owner');
  if(deadline<=BigInt(Math.floor(Date.now()/1000)))throw Error('Signed rescue has expired');
  if(deadline>BigInt(Math.floor(Date.now()/1000)+7*86400))throw Error('Deadline cannot exceed 7 days');
  const id=keccak256(new TextEncoder().encode(JSON.stringify([p.chainId,p.owner,p.delegate,p.rescue.nonce,p.rescue.signature]))).slice(2,14);
  return {id,owner:getAddress(p.owner),delegate:getAddress(p.delegate),chainId:Number(chainId),delegateCodeHash:p.delegateCodeHash.toLowerCase(),auth:{address:getAddress(p.auth.address),nonce:authNonce,chainId,signature:p.auth.signature},rescue:{token:getAddress(p.rescue.token),destination:getAddress(p.rescue.destination),minAmount,nonce,deadline,signature:p.rescue.signature}};
}
export function toJsonJob(p){return {...p,chainId:String(p.chainId),auth:{...p.auth,nonce:p.auth.nonce.toString(),chainId:p.auth.chainId.toString()},rescue:{...p.rescue,minAmount:p.rescue.minAmount.toString(),nonce:p.rescue.nonce.toString(),deadline:p.rescue.deadline.toString()}};}
export function safePublicRpc(url){return parseHttps(url)}
export const ZERO=ZeroAddress;

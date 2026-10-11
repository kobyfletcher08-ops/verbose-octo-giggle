export function safeError(error) {
  const codes={NETWORK_ERROR:'RPC network error.',SERVER_ERROR:'RPC server error.',TIMEOUT:'Request timed out.',CALL_EXCEPTION:'Contract simulation reverted.',INSUFFICIENT_FUNDS:'Insufficient funds for gas or the configured trade.',NONCE_EXPIRED:'Wallet nonce changed; check for a pending transaction.',UNKNOWN_ERROR:'RPC rejected the request.'};
  if(error?.code)return codes[error.code]??'Request failed ('+String(error.code).replace(/[^A-Z_0-9]/g,'').slice(0,40)+').';
  return String(error?.message??'Request failed.').replace(/https?:\/\/\S+/g,'[endpoint]').replace(/\b\d{5,}:[A-Za-z0-9_-]+/g,'[bot token]').slice(0,350);
}

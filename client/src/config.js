// The server address lives here, in source, so players never type an IP, port or URL.
// The client tries each entry in order and keeps the first one that answers.
//
// 1. Same origin: used automatically when this page is served by the IQ180 server itself (laptop A).
// 2. SERVER_URL: the ngrok free static domain that tunnels to the server. It never changes.
// 3. LAN_FALLBACK_URL: the server laptop's Wi-Fi IP, for when the venue internet is down.
//    It can go stale if the IP changes; that only matters if the tunnel is also unavailable.
export const SERVER_URL = 'https://YOUR-STATIC-DOMAIN.ngrok-free.app';
export const LAN_FALLBACK_URL = 'http://192.168.1.142:3000';

export const CONNECT_TIMEOUT_MS = 4000;

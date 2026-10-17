/**
 * Rules for requests that arrive through the ngrok tunnel. The tunnel manager owns the live instance and the
 * settings API mutates it; AuthService and WsGateway only read it.
 */
export interface NgrokPolicy {
  /** When non-empty, only these client IPs may use the tunnel. */
  allowedIps: string[];
  /** Block write operations for tunnel clients. */
  readOnly: boolean;
}

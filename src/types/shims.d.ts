declare module "qrcode-terminal" {
  export function generate(text: string, opts: { small?: boolean }, cb: (qr: string) => void): void;
}

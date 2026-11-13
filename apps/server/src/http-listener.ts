import type { AddressInfo, Server } from 'node:net';

// HTTP clients enforce the Fetch Standard's port restrictions: https://fetch.spec.whatwg.org/#port-blocking
const restrictedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const isHttpPort = (port: number): boolean => !restrictedPorts.has(port);

export async function listenHttp(server: Server, host: string, port: number): Promise<AddressInfo> {
  const rejected = new Set<number>();
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address() as AddressInfo;
    if (isHttpPort(address.port)) return address;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (rejected.has(address.port)) {
      throw new Error(`Automatic port selection repeatedly returned restricted HTTP port ${address.port}. Set ROWWEAVE_PORT to an HTTP-compatible port.`);
    }
    rejected.add(address.port);
  }
}

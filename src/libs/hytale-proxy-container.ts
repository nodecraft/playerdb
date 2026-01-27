import { Container } from '@cloudflare/containers';

export class HytaleProxyContainer extends Container {
	defaultPort = 8080;
	sleepAfter = '5m'; // Sleep after 5 minutes of inactivity
}

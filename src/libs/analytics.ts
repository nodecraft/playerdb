import type { Environment } from '../types';

type AnalyticsData = {
	type: string;
	error?: string;
	request_type?: string;
	cached?: boolean;
};
export function writeDataPoint(
	env: Environment,
	request: Request,
	data: AnalyticsData,
) {
	/* ORDER HERE IS VERY IMPORTANT. IF ANYTHING CHANGES, MUST BE APPENDED */
	const endTime = Date.now();
	const responseTime = env.startTime ? endTime - env.startTime.getTime() : 0;

	let userAgent = request.headers.get('user-agent') || 'unknown';
	// anonymous Tiers user agents
	// They look like: Tiers 0.4.1_1.21-1.21.1 on 1.21.1 played by cherryjimbo
	if (userAgent.startsWith('Tiers ') && userAgent.includes('played by ')) {
		userAgent = userAgent.split('played by ')[0].trim();
	}

	const reportData: AnalyticsEngineDataPoint = {
		blobs: [
			data.type || 'unknown',
			data.error || '',
			data.request_type || 'unknown', // http | tcp
			request.url,
			userAgent,
			request.headers.get('referer'),
			(request.cf?.httpProtocol || 'unknown') as string,
			(request.cf?.city || 'unknown') as string,
			(request.cf?.colo || 'unknown') as string,
			(request.cf?.country || 'unknown') as string,
			(request.cf?.tlsVersion || 'unknown') as string,
		],
		doubles: [
			(request.cf?.asn || 0) as number,
			data.cached ? 1 : 0,
			responseTime,
		],
	};
	if (!env.PLAYERDB_ANALYTICS) {
		return;
	}
	try {
		env.PLAYERDB_ANALYTICS.writeDataPoint(reportData);
	} catch (err) {
		console.error(err);
	}
}

import { createHash } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export type VtigerFunctionsContext = IExecuteFunctions | ILoadOptionsFunctions;

export interface VtigerCredentials {
	baseUrl: string;
	username: string;
	accessKey: string;
}

export interface VtigerField {
	name: string;
	label: string;
	mandatory: boolean;
	nullable?: boolean;
	editable?: boolean;
	default?: string;
	type: {
		name: string;
		refersTo?: string[];
		format?: string;
		picklistValues?: Array<{ label: string; value: string }>;
	};
}

export interface VtigerDescribeResult {
	name: string;
	label: string;
	idPrefix: string;
	isEntity?: boolean;
	fields: VtigerField[];
	[key: string]: unknown;
}

export const INVENTORY_MODULES = ['Quotes', 'Invoice', 'SalesOrder', 'PurchaseOrder'];

export function isInventoryModule(module: string): boolean {
	return INVENTORY_MODULES.includes(module);
}

const SESSION_TTL_MS = 10 * 60 * 1000;

const sessionCache = new Map<string, { sessionName: string; expiresAt: number }>();
const describeCache = new Map<string, VtigerDescribeResult>();

async function getCredentials(
	context: VtigerFunctionsContext,
): Promise<{ credentials: VtigerCredentials; cacheKey: string; baseUrl: string }> {
	const credentials = (await context.getCredentials('vtigerCrmApi')) as unknown as VtigerCredentials;
	const baseUrl = credentials.baseUrl.replace(/\/+$/, '');
	const cacheKey = createHash('sha256')
		.update(`${baseUrl}|${credentials.username}|${credentials.accessKey}`)
		.digest('hex');
	return { credentials, cacheKey, baseUrl };
}

function parseResponse(context: VtigerFunctionsContext, response: unknown): IDataObject {
	if (typeof response === 'string') {
		try {
			return JSON.parse(response) as IDataObject;
		} catch {
			throw new NodeOperationError(
				context.getNode(),
				`VTiger returned a non-JSON response: ${response.slice(0, 200)}`,
			);
		}
	}
	return response as IDataObject;
}

async function login(context: VtigerFunctionsContext): Promise<string> {
	const { credentials, cacheKey, baseUrl } = await getCredentials(context);

	const challengeResponse = parseResponse(
		context,
		await context.helpers.httpRequest({
			method: 'GET',
			url: `${baseUrl}/webservice.php`,
			qs: { operation: 'getchallenge', username: credentials.username },
		}),
	);

	if (!challengeResponse.success) {
		const error = challengeResponse.error as IDataObject | undefined;
		throw new NodeOperationError(
			context.getNode(),
			`VTiger getchallenge failed: ${error?.message ?? 'Unknown error'}`,
		);
	}

	const token = (challengeResponse.result as IDataObject).token as string;
	const hashedAccessKey = createHash('md5')
		.update(`${token}${credentials.accessKey}`)
		.digest('hex');

	const loginResponse = parseResponse(
		context,
		await context.helpers.httpRequest({
			method: 'POST',
			url: `${baseUrl}/webservice.php`,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				operation: 'login',
				username: credentials.username,
				accessKey: hashedAccessKey,
			}).toString(),
		}),
	);

	if (!loginResponse.success) {
		const error = loginResponse.error as IDataObject | undefined;
		throw new NodeOperationError(
			context.getNode(),
			`VTiger login failed: ${error?.message ?? 'Unknown error'}. Check your username and access key.`,
		);
	}

	const sessionName = (loginResponse.result as IDataObject).sessionName as string;
	sessionCache.set(cacheKey, { sessionName, expiresAt: Date.now() + SESSION_TTL_MS });
	return sessionName;
}

async function getSessionName(
	context: VtigerFunctionsContext,
): Promise<{ sessionName: string; cacheKey: string; baseUrl: string }> {
	const { cacheKey, baseUrl } = await getCredentials(context);
	const cached = sessionCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return { sessionName: cached.sessionName, cacheKey, baseUrl };
	}
	const sessionName = await login(context);
	return { sessionName, cacheKey, baseUrl };
}

export async function vtigerApiRequest(
	this: VtigerFunctionsContext,
	operation: string,
	options: {
		method: 'GET' | 'POST';
		qs?: IDataObject;
		body?: IDataObject;
	} = { method: 'GET' },
	retryOnExpiredSession = true,
): Promise<IDataObject | IDataObject[]> {
	const { sessionName, cacheKey, baseUrl } = await getSessionName(this);

	const requestOptions: IHttpRequestOptions = {
		method: options.method,
		url: `${baseUrl}/webservice.php`,
	};

	if (options.method === 'GET') {
		requestOptions.qs = { operation, sessionName, ...(options.qs ?? {}) };
	} else {
		requestOptions.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
		requestOptions.body = new URLSearchParams(
			Object.entries({ operation, sessionName, ...(options.body ?? {}) }).map(([k, v]) => [
				k,
				String(v),
			]),
		).toString();
	}

	const response = parseResponse(this, await this.helpers.httpRequest(requestOptions));

	if (!response.success) {
		const error = response.error as IDataObject | undefined;
		const code = (error?.code as string | undefined) ?? '';
		if (
			retryOnExpiredSession &&
			(code === 'INVALID_SESSIONID' ||
				code === 'AUTHENTICATION_REQUIRED' ||
				code === 'INVALID_SESSIONID_OR_TOKEN')
		) {
			sessionCache.delete(cacheKey);
			return vtigerApiRequest.call(this, operation, options, false);
		}
		throw new NodeOperationError(
			this.getNode(),
			`VTiger "${operation}" failed: ${error?.message ?? 'Unknown error'}${code ? ` (code: ${code})` : ''}`,
		);
	}

	return response.result as IDataObject | IDataObject[];
}

export async function vtigerDescribe(
	context: VtigerFunctionsContext,
	module: string,
): Promise<VtigerDescribeResult> {
	const { cacheKey } = await getCredentials(context);
	const key = `${cacheKey}|${module}`;
	const cached = describeCache.get(key);
	if (cached) return cached;

	const result = (await vtigerApiRequest.call(context, 'describe', {
		method: 'GET',
		qs: { elementType: module },
	})) as VtigerDescribeResult;

	describeCache.set(key, result);
	return result;
}

export async function getRecordWebserviceId(
	context: VtigerFunctionsContext,
	module: string,
	recordId: string,
): Promise<string> {
	const trimmed = recordId.trim();
	if (/^\d+x\d+$/.test(trimmed)) return trimmed;
	const describe = await vtigerDescribe(context, module);
	return `${describe.idPrefix}x${trimmed}`;
}

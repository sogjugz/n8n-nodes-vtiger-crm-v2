import type {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class VtigerCrmApi implements ICredentialType {
	name = 'vtigerCrmApi';

	displayName = 'VTiger CRM V2 API';

	icon = { light: 'file:vtiger.svg', dark: 'file:vtiger.svg' } as const;

	documentationUrl = 'https://community.vtiger.com/help/vtigercrm/developers/third-party-app-integration.html';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://crm.example.com',
			description:
				'The base URL of your VTiger CRM installation, e.g. <code>https://crm.example.com</code>. Do not include <code>/webservice.php</code> or a trailing slash',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			required: true,
			default: '',
			description: 'The username you use to log in to VTiger CRM',
		},
		// eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password -- the access key is a secret token from VTiger My Preferences
		{
			displayName: 'Access Key',
			name: 'accessKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			required: true,
			default: '',
			description:
				'The webservice access key found in VTiger under My Preferences (not your login password)',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/webservice.php',
			method: 'GET',
			qs: {
				operation: 'getchallenge',
				username: '={{$credentials.username}}',
			},
		},
	};
}

import type {
	IDataObject,
	IExecuteFunctions,
	FieldType,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ResourceMapperFields,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	INVENTORY_MODULES,
	getRecordWebserviceId,
	isInventoryModule,
	vtigerApiRequest,
	vtigerDescribe,
} from './GenericFunctions';
import type { VtigerField } from './GenericFunctions';

const NUMERIC_FIELD_TYPES = new Set(['integer', 'double', 'currency']);

const OPERATOR_SYMBOLS: Record<string, string> = {
	different: '!=',
	equal: '=',
	equalOrGreater: '>=',
	equalOrLess: '<=',
	greater: '>',
	less: '<',
};

function escapeSqlString(value: string): string {
	return value.replace(/'/g, "''");
}

function normalizeQueryValue(rawValue: string): string {
	const value = rawValue.trim();
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function mapVtigerFieldType(field: VtigerField): {
	type: FieldType;
	options?: INodePropertyOptions[];
} {
	const typeName = field.type.name;
	if (
		(typeName === 'picklist' || typeName === 'multipicklist') &&
		field.type.picklistValues?.length
	) {
		return {
			type: 'options',
			options: field.type.picklistValues.map((entry) => ({
				name: entry.label,
				value: entry.value,
			})),
		};
	}
	if (typeName === 'boolean') return { type: 'boolean' };
	if (NUMERIC_FIELD_TYPES.has(typeName)) return { type: 'number' };
	if (typeName === 'date' || typeName === 'datetime') return { type: 'dateTime' };
	return { type: 'string' };
}

function formatQueryValue(fieldType: string | undefined, rawValue: string): string {
	const value = normalizeQueryValue(rawValue);
	if (fieldType === 'boolean') {
		return /^(true|on|1)$/i.test(value) ? '1' : '0';
	}
	if (fieldType && NUMERIC_FIELD_TYPES.has(fieldType) && /^-?\d+(\.\d+)?$/.test(value)) {
		return value;
	}
	return `'${escapeSqlString(value)}'`;
}

export class VtigerCrm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'VTiger CRM V2',
		name: 'vtigerCrm',
		icon: { light: 'file:vtiger.svg', dark: 'file:vtiger.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["module"]}}',
		description: 'Create, update, delete and query records in VTiger CRM 6.x via its webservice API',
		defaults: {
			name: 'VTiger CRM V2',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vtigerCrmApi',
				required: true,
			},
		],
		properties: [
			// eslint-disable-next-line @n8n/community-nodes/resource-operation-pattern -- all operations act on the module selected in `module`, so a resource selector would be redundant
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new record in a module',
						action: 'Create a record',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a record',
						action: 'Delete a record',
					},
					{
						name: 'Describe',
						value: 'describe',
						description:
							'Get the metadata of a module: fields, types, picklist values and the ID prefix used in reference fields',
						action: 'Describe a module',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Retrieve a single record by ID',
						action: 'Get a record',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Query records with a filter builder or a raw VTiger query',
						action: 'Get many records',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update an existing record',
						action: 'Update a record',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Module Name or ID',
				name: 'module',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModules',
				},
				required: true,
				default: '',
				description:
					'The VTiger module (entity type) to work with. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Record ID',
				name: 'recordId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['update', 'delete', 'get'],
					},
				},
				default: '',
				placeholder: '12345 or 12x12345',
				description:
					'The numeric record ID or the full webservice ID (e.g. <code>12x12345</code>)',
			},

			// ----------------------------------
			//         create / update
			// ----------------------------------
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'resourceMapper',
				noDataExpression: true,
				required: true,
				displayOptions: {
					show: {
						operation: ['create', 'update'],
					},
				},
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				typeOptions: {
					loadOptionsDependsOn: ['module'],
					resourceMapper: {
						resourceMapperMethod: 'getModuleFields',
						mode: 'add',
						fieldWords: {
							singular: 'field',
							plural: 'fields',
						},
						addAllFields: false,
						supportAutoMap: true,
					},
				},
				description:
					'Picklist fields offer their allowed values. Reference-type fields (e.g. assigned_user_id, account_id) expect webservice IDs like <code>19x1</code>',
			},
			{
				displayName:
					'This is an inventory module. Its productid is set automatically to the product of the first line item, and at least one line item is required.',
				name: 'inventoryNotice',
				type: 'notice',
				displayOptions: {
					show: {
						operation: ['create'],
						module: INVENTORY_MODULES,
					},
				},
				default: '',
			},
			{
				displayName: 'Line Items',
				name: 'lineItems',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				displayOptions: {
					show: {
						operation: ['create', 'update'],
						module: INVENTORY_MODULES,
					},
				},
				default: {},
				placeholder: 'Add Line Item',
				description: 'Inventory line items (products/services) for this record. On update, existing line items are preserved if none are added here.',
				options: [
					{
						name: 'lineItem',
						displayName: 'Line Item',
						values: [
							{
						displayName: 'Comment',
						name: 'comment',
						type: 'string',
						default: '',
							},
							{
						displayName: 'Discount Amount',
						name: 'discountAmount',
						type: 'number',
						default: 0
							},
							{
						displayName: 'Discount Percent',
						name: 'discountPercent',
						type: 'number',
						default: 0
							},
							{
						displayName: 'List Price',
						name: 'listPrice',
						type: 'number',
							required:	true,
						default: 0
							},
							{
						displayName: 'Product Name or ID',
						name: 'product',
						type: 'options',
							required:	true,
						default: '',
						description: 'Choose from the list, or specify a webservice ID (e.g. <code>14x123</code>) using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
						displayName: 'Quantity',
						name: 'quantity',
						type: 'number',
							required:	true,
						default: 1
							},
						],
					},
				],
			},

			// ----------------------------------
			//              getAll
			// ----------------------------------
			{
				displayName: 'Query Mode',
				name: 'queryMode',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						operation: ['getAll'],
					},
				},
				options: [
					{
						name: 'Query Builder',
						value: 'builder',
						description: 'Build the query by selecting fields and conditions',
					},
					{
						name: 'Raw Query',
						value: 'raw',
						description: 'Write the VTiger SQL-like query yourself',
					},
				],
				default: 'builder',
			},
			{
				displayName: 'Conditions',
				name: 'conditions',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				displayOptions: {
					show: {
						operation: ['getAll'],
						queryMode: ['builder'],
					},
				},
				default: {},
				placeholder: 'Add Condition',
				description:
					'WHERE conditions, evaluated left to right. VTiger does not support parentheses grouping.',
				options: [
					{
						name: 'condition',
						displayName: 'Condition',
						values: [
							{
								displayName: 'Combine With',
								name: 'combine',
								type: 'options',
								options: [
									{ name: 'AND', value: 'and' },
									{ name: 'OR', value: 'or' },
								],
								default: 'and',
								description: 'How this condition combines with the previous one. Ignored on the first condition.',
							},
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getFields',
									loadOptionsDependsOn: ['module'],
								},
								required: true,
								default: '',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Operator',
								name: 'operator',
								type: 'options',
								options: [
									{ name: 'Contains', value: 'contains' },
									{ name: 'Different', value: 'different' },
									{ name: 'Ends With', value: 'endsWith' },
									{ name: 'Equal', value: 'equal' },
									{ name: 'Equal or Greater', value: 'equalOrGreater' },
									{ name: 'Equal or Less', value: 'equalOrLess' },
									{ name: 'Greater', value: 'greater' },
									{ name: 'In List', value: 'in' },
									{ name: 'Less', value: 'less' },
									{ name: 'Starts With', value: 'startsWith' },
								],
								default: 'equal',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								required: true,
								default: '',
								description:
									'Enter the plain value without quotes (e.g. <code>En Servicio</code>). For "In List" use a comma-separated list (e.g. <code>a,b,c</code>). Wildcards are added automatically for Contains, Starts With and Ends With',
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				displayOptions: {
					show: {
						operation: ['getAll'],
						queryMode: ['builder'],
					},
				},
				default: {},
				options: [
					{
						displayName: 'Include Field Names or IDs',
						name: 'searchFields',
						type: 'multiOptions',
						typeOptions: {
							loadOptionsMethod: 'getFields',
							loadOptionsDependsOn: ['module'],
						},
						default: [],
						description:
							'Fields to return. Leave empty to select all fields (SELECT *). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 100,
						},
						default: 50,
						description: 'Max number of results to return',
						hint: 'VTiger returns at most 100 records per request',
					},
					{
						displayName: 'Return All',
						name: 'returnAll',
						type: 'boolean',
						default: false,
						description: 'Whether to return all results or only up to a given limit',
						hint: 'VTiger is queried repeatedly in batches of 100 records (the API maximum) until no more results are returned',
					},
					{
						displayName: 'Sort By Field Name or ID',
						name: 'orderBy',
						type: 'options',
						typeOptions: {
							loadOptionsMethod: 'getFields',
							loadOptionsDependsOn: ['module'],
						},
						default: '',
						description:
							'Field to sort results by. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Sort Direction',
						name: 'orderDirection',
						type: 'options',
						options: [
							{ name: 'Ascending', value: 'ASC' },
							{ name: 'Descending', value: 'DESC' },
						],
						default: 'ASC',
					},
				],
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				required: true,
				displayOptions: {
					show: {
						operation: ['getAll'],
						queryMode: ['raw'],
					},
				},
				default: '',
				placeholder: "SELECT * FROM Contacts WHERE lastname like '%smith%' LIMIT 10",
				description:
					'VTiger SQL-like query. Single module only, no JOINs, no parentheses. VTiger caps results at 100 per query; without an explicit LIMIT, "Return All" paginates automatically.',
			},
			{
				displayName: 'Options',
				name: 'rawOptions',
				type: 'collection',
				placeholder: 'Add Option',
				displayOptions: {
					show: {
						operation: ['getAll'],
						queryMode: ['raw'],
					},
				},
				default: {},
				options: [
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 100,
						},
						default: 50,
						description: 'Max number of results to return',
						hint: 'Ignored when the query has an explicit LIMIT clause. VTiger returns at most 100 records per request.',
					},
					{
						displayName: 'Return All',
						name: 'returnAll',
						type: 'boolean',
						default: false,
						description: 'Whether to return all results or only up to a given limit',
						hint: 'Ignored when the query has an explicit LIMIT clause. VTiger is queried repeatedly in batches of 100 records (the API maximum) until no more results are returned.',
					},
				],
			},
		],
		usableAsTool: true,
	};

	methods = {
		loadOptions: {
			async getModules(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const result = (await vtigerApiRequest.call(this, 'listtypes', {
					method: 'GET',
				})) as IDataObject;

				const rawTypes = Array.isArray(result) ? result : (result.types as string[]);
				const information = (result.information ?? {}) as Record<
					string,
					{ isEntity?: boolean; label?: string }
				>;

				return rawTypes
					.filter(
						(type) =>
							typeof type === 'string' &&
							(information[type] === undefined || information[type].isEntity !== false),
					)
					.map((type) => ({ name: information[type]?.label ?? type, value: type }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const module = this.getCurrentNodeParameter('module') as string;
				if (!module) return [];

				const describe = await vtigerDescribe(this, module);
				return describe.fields
					.map((field) => ({
						name: `${field.label} (${field.name})${field.mandatory ? ' *' : ''}`,
						value: field.name,
					}))
					.sort((a, b) => {
						const aRequired = a.name.endsWith('*') ? 0 : 1;
						const bRequired = b.name.endsWith('*') ? 0 : 1;
						return aRequired - bRequired || a.name.localeCompare(b.name);
					});
			},

			async getProducts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const rows = (await vtigerApiRequest.call(this, 'query', {
						method: 'GET',
						qs: { query: 'SELECT id, productname FROM Products ORDER BY productname LIMIT 100;' },
					})) as IDataObject[];
					return rows.map((row) => ({
						name: String(row.productname),
						value: String(row.id),
					}));
				} catch {
					return [];
				}
			},
		},
		resourceMapping: {
			async getModuleFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const module = this.getCurrentNodeParameter('module') as string;
				if (!module) return { fields: [] };

				const operation = this.getCurrentNodeParameter('operation') as string;
				const describe = await vtigerDescribe(this, module);

				return {
					fields: describe.fields
						.filter((field) => field.editable !== false)
						.map((field) => {
							const mapped = mapVtigerFieldType(field);
							return {
								id: field.name,
								displayName: field.label,
								required: operation === 'create' ? field.mandatory : false,
								defaultMatch: true,
								display: true,
								type: mapped.type,
								options: mapped.options,
								defaultValue: field.default || null,
							};
						}),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const module = this.getNodeParameter('module', i) as string;

				if (operation === 'create' || operation === 'update') {
					const fieldsParam = this.getNodeParameter('fields', i, {
						value: {},
					}) as ResourceMapperValue;

					const userFields = { ...(fieldsParam.value ?? {}) } as IDataObject;
					let element: IDataObject;

					if (operation === 'update') {
						const recordId = this.getNodeParameter('recordId', i) as string;
						const webserviceId = await getRecordWebserviceId(this, module, recordId);
						// VTiger requires the full entity on update: merge existing values
						// with the user-provided fields so mandatory fields keep their values
						const existing = (await vtigerApiRequest.call(this, 'retrieve', {
							method: 'GET',
							qs: { id: webserviceId },
						})) as IDataObject;
						element = { ...existing, ...userFields, id: webserviceId };
					} else {
						element = userFields;
					}

					if (isInventoryModule(module)) {
						const lineItems = this.getNodeParameter('lineItems.lineItem', i, []) as Array<{
							product: string;
							quantity: number;
							listPrice: number;
							discountPercent?: number;
							discountAmount?: number;
							comment?: string;
						}>;

						if (lineItems.length > 0) {
							element.LineItems = lineItems.map((item, index) => {
								const line: IDataObject = {
									productid: item.product,
									sequence_no: index + 1,
									quantity: item.quantity,
									listprice: item.listPrice,
								};
								if (item.discountPercent) line.discount_percent = item.discountPercent;
								if (item.discountAmount) line.discount_amount = item.discountAmount;
								if (item.comment) line.comment = item.comment;
								return line;
							});
							element.productid = lineItems[0].product;
						}
					}

					if (operation === 'create') {
						const describe = await vtigerDescribe(this, module);
						const missing = describe.fields
							.filter(
								(field: VtigerField) =>
									field.mandatory &&
									(element[field.name] === undefined || element[field.name] === ''),
							)
							.map((field) => `${field.label} (${field.name})`);
						if (missing.length > 0) {
							throw new NodeOperationError(
								this.getNode(),
								`Missing required fields for "${module}": ${missing.join(', ')}`,
								{ itemIndex: i },
							);
						}
						if (isInventoryModule(module) && !element.LineItems) {
							throw new NodeOperationError(
								this.getNode(),
								`"${module}" is an inventory module: at least one line item is required so productid can be set.`,
								{ itemIndex: i },
							);
						}
					}

					const result = await vtigerApiRequest.call(this, operation, {
						method: 'POST',
						body: {
							elementType: module,
							element: JSON.stringify(element),
						},
					});
					returnData.push({ json: result as IDataObject, pairedItem: { item: i } });
				} else if (operation === 'describe') {
					const result = await vtigerApiRequest.call(this, 'describe', {
						method: 'GET',
						qs: { elementType: module },
					});
					returnData.push({ json: result as IDataObject, pairedItem: { item: i } });
				} else if (operation === 'delete' || operation === 'get') {
					const recordId = this.getNodeParameter('recordId', i) as string;
					const webserviceId = await getRecordWebserviceId(this, module, recordId);

					if (operation === 'delete') {
						const result = await vtigerApiRequest.call(this, 'delete', {
							method: 'POST',
							body: { id: webserviceId },
						});
						returnData.push({
							json: { deleted: true, id: webserviceId, ...(result as IDataObject) },
							pairedItem: { item: i },
						});
					} else {
						const result = await vtigerApiRequest.call(this, 'retrieve', {
							method: 'GET',
							qs: { id: webserviceId },
						});
						returnData.push({ json: result as IDataObject, pairedItem: { item: i } });
					}
				} else if (operation === 'getAll') {
					const queryMode = this.getNodeParameter('queryMode', i) as string;
					const optionsPath = queryMode === 'raw' ? 'rawOptions' : 'options';
					const returnAll = this.getNodeParameter(`${optionsPath}.returnAll`, i, false) as boolean;

					let baseQuery: string;
					if (queryMode === 'raw') {
						baseQuery = (this.getNodeParameter('query', i) as string)
							.trim()
							.replace(/;+$/, '');
					} else {
						const describe = await vtigerDescribe(this, module);
						const fieldTypes = new Map(describe.fields.map((f) => [f.name, f.type.name]));

						const selectedFields = this.getNodeParameter('options.searchFields', i, []) as string[];
						const columns = selectedFields.length ? selectedFields.join(', ') : '*';

						const conditions = this.getNodeParameter('conditions.condition', i, []) as Array<{
							combine: 'and' | 'or';
							field: string;
							operator: string;
							value: string;
						}>;

						const where = conditions
							.filter((c) => c.field)
							.map((c, index) => {
								const fieldType = fieldTypes.get(c.field);
								let clause: string;
								if (c.operator === 'in') {
									const values = c.value
										.split(',')
										.map((v) => formatQueryValue(fieldType, v))
										.join(', ');
									clause = `${c.field} in (${values})`;
								} else if (c.operator === 'contains') {
									clause = `${c.field} like '%${escapeSqlString(normalizeQueryValue(c.value))}%'`;
								} else if (c.operator === 'startsWith') {
									clause = `${c.field} like '${escapeSqlString(normalizeQueryValue(c.value))}%'`;
								} else if (c.operator === 'endsWith') {
									clause = `${c.field} like '%${escapeSqlString(normalizeQueryValue(c.value))}'`;
								} else {
									const symbol = OPERATOR_SYMBOLS[c.operator] ?? c.operator;
									clause = `${c.field} ${symbol} ${formatQueryValue(fieldType, c.value)}`;
								}
								return index === 0 ? clause : `${c.combine ?? 'and'} ${clause}`;
							})
							.join(' ');

						const orderBy = this.getNodeParameter('options.orderBy', i, '') as string;
						const orderDirection = this.getNodeParameter('options.orderDirection', i, 'ASC') as string;

						baseQuery = `SELECT ${columns} FROM ${module}`;
						if (where) baseQuery += ` WHERE ${where}`;
						if (orderBy) baseQuery += ` ORDER BY ${orderBy} ${orderDirection}`;
					}

					const hasExplicitLimit = /\blimit\b/i.test(baseQuery);
					const limit = returnAll
						? Infinity
						: (this.getNodeParameter(`${optionsPath}.limit`, i, 50) as number);

					const results: IDataObject[] = [];
					let offset = 0;
					let keepFetching = true;
					do {
						const pageSize = Math.min(100, limit - results.length);
						const query =
							hasExplicitLimit || pageSize <= 0
								? `${baseQuery};`
								: `${baseQuery} LIMIT ${offset > 0 ? `${offset}, ` : ''}${pageSize};`;

						const rows = (await vtigerApiRequest.call(this, 'query', {
							method: 'GET',
							qs: { query },
						})) as IDataObject[];

						results.push(...(Array.isArray(rows) ? rows : [rows]));

						if (hasExplicitLimit || rows.length < pageSize || results.length >= limit) {
							keepFetching = false;
						} else {
							offset += rows.length;
						}
					} while (keepFetching);

					for (const row of results) {
						returnData.push({ json: row, pairedItem: { item: i } });
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-21

Initial release. Successor of [`n8n-nodes-vtiger-crm`](https://github.com/sogjugz/n8n-nodes-vtiger-crm).

### Added

- Operations: Create, Update, Delete, Get, Get Many and Describe
- Dynamic module selector via `listtypes` and dynamic field schema via `describe`
- Resource mapper for Create/Update with picklist dropdowns, booleans, numbers and dates mapped from VTiger field types
- Inventory modules (Quotes, Invoice, SalesOrder, PurchaseOrder): `productid` set automatically from the first line item; existing `LineItems` preserved on update
- Update performs retrieve-then-merge since VTiger requires the full entity
- Get Many with visual query builder (fields, conditions, ORDER BY) and raw VTQL mode; automatic `LIMIT offset,100` pagination with Return All
- Credentials: base URL, username and webservice access key; session caching and automatic re-login on expired sessions

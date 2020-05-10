# Azure infrastructure

### Prerequisites

- Create an Azure account
- Install the Azure CLI
- Login to the CLI, optionally using an Azure Service Principal if you'd like

## Azure Functions

Azure Functions is used to subscribe to events emitted by Azure Storage. The event is used as a signal to provision a Virtual Machine.

### Prerequisites

Install the Azure Functions Core Tools by following instructions listed [here](https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local).
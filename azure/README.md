# Azure infrastructure

### Prerequisites

- Create an Azure account
- Install the Azure CLI
- Login to the CLI, optionally using an [Azure Service Principal](https://docs.microsoft.com/en-us/cli/azure/create-an-azure-service-principal-azure-cli?view=azure-cli-latest), if you'd like
  - You should use a service principal if you want to use a CI/CD system so you don't use your personal credentials. It is somewhat similar to _not_ using your AWS' root account credentials and instead creating an IAM user with limited access to resources.
  - You can assign roles to a service principal that would give it limited access too.

## Azure Functions

Azure Functions is used to subscribe to events emitted by Azure Storage. The event is used as a signal to provision a Virtual Machine.

### Prerequisites

Install the Azure Functions Core Tools by following instructions listed [here](https://docs.microsoft.com/en-us/azure/azure-functions/functions-run-local).

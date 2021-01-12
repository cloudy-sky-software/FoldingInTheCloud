# Folding In The Cloud

A Pulumi app for deloying Spot instances that run the [Folding@Home](https://foldingathome.org) client.

See https://foldingforum.org/viewtopic.php?f=24&t=32463&fbclid=IwAR1v8Z_2VbB__5izLF989xPRRg9WIYzbd9d5gkfAaP3jCPdkcJbeyUpIt-U.

## Introduction

There are two stacks:

-   `aws`
-   `azure`

...for, you guessed it, deploying infrastructure on AWS and Azure respectively.

The architecture between the two stacks are kept as similar as possible. However, there are some differences.

### Difference 1 - VPC configuration

For example, in the AWS infrastructure, both the event handler (Lambda) and the EC2 Spot instance are in a VPC.
Whereas, in the Azure infrastructure, creating an Azure Functions app in a VNET requires a Premium plan.
So instead, the network security rules for the Azure Spot VM is restricted to only allow certain IP addresses
to connect via SSH port 22. This is still not entirely secure from a security standpoint because the Function App
IP addresses are not "dedicated" IP addresses. So technically any Function App also running on those hosts _could_
potentially try to connect to our Spot VM. However, the chances for that are really slim. In addition,
we are also using an SSH private key only we have access to.

### Difference 2 - Event handling

> More details about this can be found in the [source code](https://github.com/praneetloke/FoldingInTheCloud/blob/master/azure/events.ts#L17).

In AWS, the Lambda handler can receive events from the EC2 service as well as the S3 bucket object change notification.
However, in Azure, there is no concept of "listening" to events from VM changes. Instead, there is a metadata service
called "Scheduled Events" that needs to be constantly monitored and is only accessible from within the VM. So the
event handler (Azure Functions) in the Azure infrastructure setup, only relies on Azure Storage blob notifications
through the use of Event Grid subscriptions.

## Running the app

> :warning: Running the Pulumi app using your cloud credentials WILL cost you money. So use this at your own risk.
> The contributors/maintainers or anyone involved with this project is NOT responsible for any costs you may incur.

First, fork this repo, delete the `Pulumi.aws.yaml` and `Pulumi.azure.yaml` files. Create your own stack, using `pulumi stack init`.

Next, generate an OpenSSH keypair for use with your server:

```
# The filename `rsa` is specifically git ignored so you don't have to worry about
# accidentally committing them to GitHub. If you use a different filename,
# be sure not to commit these files!

ssh-keygen -m PEM -f rsa
```

This will output two files, `rsa` and `rsa.pub`, in the current directory.

```
cat rsa.pub | pulumi config set publicKey --
cat rsa | pulumi config set privateKey --secret --
```

If your key is protected by a passphrase, add that too:

```
pulumi config set privateKeyPassphrase --secret [yourPassphraseHere]
```

Notice that we've used `--secret` for both `privateKey` and `privateKeyPassphrase`. This ensures their are
stored in encrypted form in the Pulumi secrets system.

### Stack configuration

As noted above, the app supports creating cloud infrastructure to run Folding@Home on AWS and Azure.
The cloud provider the app uses depends on the configuration option `cloudProvider`. It defaults to `aws`.
Your stack name (the one you enter when you run `pulumi stack init`) can be whatever you choose.
It's the configuration values that change the controls the deployment to a cloud provider.

See [`config.ts`](https://github.com/praneetloke/FoldingInTheCloud/blob/master/config.ts) for more configuration options.

### Cloud provider credentials

You will need an account with [AWS](https://portal.aws.amazon.com/billing/signup#/start) or [Azure](https://portal.azure.com) (or both :))

#### AWS Setup

Learn how to create [AWS Secret Keys](https://aws.amazon.com/premiumsupport/knowledge-center/create-access-key/). Read more about the [AWS setup for Pulumi](https://www.pulumi.com/docs/intro/cloud-providers/aws/setup/).

#### Azure Setup

Install the Azure CLI locally and log in to that. If you are planning to run this app on a CI/CD service,
then it is recommended that you use a [Service Principal](https://docs.microsoft.com/en-us/cli/azure/create-an-azure-service-principal-azure-cli?view=azure-cli-latest).

> A Service Principal is like a "bot" account that is meant to be used with non-interactive sessions such as a CI/CD service.

Read more about the [Azure setup for Pulumi](https://www.pulumi.com/docs/intro/cloud-providers/azure/setup/).

## Run it!

Run `pulumi up -s <the stack name>` and select **Yes** when you see a prompt for confirmation.

Pulumi will run a `preview` first, which will mostly be uninteresting (because nothing already exists in your account for the stack).
However, you will notice that there are quite a bit of resources to be created. This is due to the nature of the network security setup.
Instead of using a default networking setup, the instance is setup to use a private and public subnet setup. If you don't understand what
that means, to put it simply, the virtual machine/instance is not exposed to the internet directly and instead go through a "router" of
sorts that masks the instance's real IP address. It's sort of like your home Wifi router setup.

After the initial `pulumi up`, the preview will only show you the differences in what is already deployed on the cloud and what you've changed.

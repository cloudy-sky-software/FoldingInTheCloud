# Folding In The Cloud

A Pulumi app for deloying Spot instances that run the [Folding@Home](https://foldingathome.org) client.

See https://foldingforum.org/viewtopic.php?f=24&t=32463&fbclid=IwAR1v8Z_2VbB__5izLF989xPRRg9WIYzbd9d5gkfAaP3jCPdkcJbeyUpIt-U.

## Introduction

There are two stacks:
* `aws`
* `azure`

..for, you guessed it, deploying infrastructure on AWS and Azure.

The infrastructure setup between the two stacks are kept as similar as possible.

However, there are some differences.

### Difference 1 (VPC configuration)

For example, in the AWS infrastructure, both the event handler (Lambda) and the EC2 Spot instance are in a VPC. Whereas, in the Azure infrastructure, creating an Azure Functions app in a VNET requires a Premium plan. So instead, the network security rules for the Azure Spot VM is restricted to only allow certain IP addresses to connect via SSH port 22. This is still not entirely secure from a security standpoint because the Function App IP addresses are not "dedicated" IP addresses. So technically any Function App also running on those hosts _could_ potentially try to connect to our Spot VM. However, the chances for that are really slim. In addition, we are also using an SSH private key only we have access to.

### Difference 2 (Event handling)

In AWS, the Lambda handler can receive events from the EC2 service as well as the S3 bucket object change notification. However, in Azure, there is no concept of "listening" to events from VM changes. Instead, there is a metadata service called "Scheduled Events" that needs to be constantly monitored and is only accessible from within the VM. So the event handler (Azure Functions) in the Azure infrastructure setup, only relies on Azure Storage blob notifications through the use of Event Grid subscriptions.

## Running the app

First, create a stack, using `pulumi stack init`.

Next, generate an OpenSSH keypair for use with your server:

```
$ ssh-keygen -m PEM -f rsa
```

This will output two files, `rsa` and `rsa.pub`, in the current directory. Be sure not to commit these files!

We then need to configure our stack so that the public key is used by our EC2 instance, and the private key used
for subsequent SCP and SSH steps that will configure our server after it is stood up.

```
$ cat rsa.pub | pulumi config set publicKey --
$ cat rsa | pulumi config set privateKey --secret --
```

If your key is protected by a passphrase, add that too:

```
$ pulumi config set privateKeyPassphrase --secret [yourPassphraseHere]
```

Notice that we've used `--secret` for both `privateKey` and `privateKeyPassphrase`. This ensures their are
stored in encrypted form in the Pulumi secrets system.

Also set your desired AWS region:

```
$ pulumi config set aws:region us-west-2
```

From there, you can run `pulumi up` and all resources will be provisioned and configured.

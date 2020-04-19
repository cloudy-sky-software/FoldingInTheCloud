# Deploy Spot Instances on AWS EC2 Using Pulumi

A Pulumi-based infrastructure app for deloying EC2 Spot Instance for running Folding@Home client.

See https://foldingforum.org/viewtopic.php?f=24&t=32463&fbclid=IwAR1v8Z_2VbB__5izLF989xPRRg9WIYzbd9d5gkfAaP3jCPdkcJbeyUpIt-U.

## Introduction

This app establishes SSH2 tunnel to copy and execute provisioning scripts in order to install Halyard on the EC2 instance. Any time the scripts are changed, subsequent `pulumi up` would copy/execute the scripts again.

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

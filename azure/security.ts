import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";

export class SpotVmSecurity extends pulumi.ComponentResource {
    private name: string;

    constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:vm:security", name, undefined, opts);
        this.name = name;

        this.registerOutputs({});
    }
}

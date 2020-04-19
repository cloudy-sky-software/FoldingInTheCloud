// Copyright 2016-2019, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as pulumi from "@pulumi/pulumi";
import * as uuid from "uuid";

// Provisioner lets a custom action run the first time a resource has been created. It takes as input
// a dependent property. Anytime its value changes, the resource is replaced and will re-run its logic.
export class Provisioner<T> extends pulumi.dynamic.Resource {

    constructor(name: string, props: ProvisionerProperties<T>, opts?: pulumi.CustomResourceOptions) {
        const provider = {
            diff: async (id: pulumi.ID, olds: State<T>, news: State<T>) => {
                const replace = JSON.stringify(olds.dep) !== JSON.stringify(news.dep);
                return {
                    changes: replace,
                    replaces: replace ? ["dep"] : undefined,
                    deleteBeforeReplace: true,
                };
            },
            create: async (inputs: State<T>) => {
                await props.onCreate(inputs.dep);
                return { id: uuid.v4(), outs: inputs };
            },
        };
        super(provider, name, props, opts);
    }
}

export interface ProvisionerProperties<T> {
    dep: pulumi.Input<T>;
    onCreate: (dep: pulumi.Unwrap<T>) => Promise<void>;
}

interface State<T> {
    dep: pulumi.Unwrap<T>;
}

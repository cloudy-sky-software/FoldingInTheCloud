import * as pulumi from "@pulumi/pulumi";

function getDefaultTags(): Record<string, string> {
    return {
        project: pulumi.getProject(),
        stack: pulumi.getStack(),
    };
}

/**
 * registerDefaultTags registers a global stack transformation that merges a set
 * of tags with whatever was also explicitly added to the resource definition.
 */
export function registerDefaultTags(): void {
    const autoTags = getDefaultTags();
    pulumi.runtime.registerStackTransformation((args) => {
        if (args.props["tags"]) {
            args.props["tags"] = { ...args.props["tags"], ...autoTags };
            return { props: args.props, opts: args.opts };
        }
        return undefined;
    });
}

export interface InstanceSecurity {
    setupIdentities(): Promise<void>;
    setupPrivateNetworking(): Promise<void>;
}

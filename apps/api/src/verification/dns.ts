/**
 * DNS types/resolver re-exported from @mailcheckr/core (the shared core is
 * the source of truth for the resolver contract: NXDOMAIN / temporary /
 * timeout are signalled via DnsResolutionError kinds; ENODATA is []).
 */
export { NodeDnsResolver, DnsResolutionError, type DnsResolver, type MxRecord } from "@mailcheckr/core";

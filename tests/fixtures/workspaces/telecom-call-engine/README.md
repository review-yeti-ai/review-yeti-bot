# Generic Telecom Call Engine

A standard-compliant, modular telecommunications call processing engine fixture designed for autonomous code review benchmarks.

## Architecture

1. **`sip_signaling_service`**: RFC 3261 SIP state machine, dialog manager, RFC 4566 SDP negotiator, and RFC 3515/3891 call transfer coordinator.
2. **`rtp_media_gateway`**: RFC 3550 RTP/RTCP packet handler, adaptive jitter buffer with G.711 Appendix I PLC, ITU-T G.711 μ-law/A-law & Opus codecs, and UDP port pool allocator.
3. **`cdr_pipeline`**: Canonical CDR ingestion, E.164 Radix Trie tariff rating engine, multi-tenant concurrency & quota tracker, and async batch SQL statement logger.
4. **`pbx_device_manager`**: SIP endpoint registration registry with symmetric NAT, RFC 2617/7616 MD5 Digest authentication, weighted round-robin trunk allocator with circuit breaker, and CTI webhook dispatcher with HMAC-SHA256 signing and SSRF protection.

## Standards Compliance

- **SIP**: IETF RFC 3261, RFC 3515, RFC 3891, RFC 3581
- **RTP/RTCP**: IETF RFC 3550, RFC 7587, RFC 4733
- **SDP**: IETF RFC 4566, RFC 3264
- **Auth**: IETF RFC 2617, RFC 7616
- **Audio & Codes**: ITU-T G.711 (μ-law & A-law), ITU-T E.164, ITU-T Q.850

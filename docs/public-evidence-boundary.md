# Public evidence boundary (private, offline seam)
Reconstructed after workspace loss; this is not the original reviewed commit.
EvidenceLedger separates trusted collected text from model claims. Only a controller-owned collector may record. Model claims contain receiptId and an exact excerpt, never authoritative source metadata. Receipts bind task/run/source message and revisions, expire after five minutes, and carry a SHA256 of extracted UTF8 text. Exact substring verification does not establish semantic support or truth.

Limits: 16 predeclared HTTPS documents, 128 receipts, 64KiB extracted text, eight claims, 2,000 characters per excerpt. Revocation is permanent for the ledger lifetime; after 128 distinct tombstones further revocation seals the store. A new store is not renewed authorization. Future controller integration MUST check current admission before collection and publication.

This module is not connected to ResearchResult, model tools, publication or providers. It is not network attestation or a complete SSRF defense. No public endpoint exposes record. Persistence, authorization integration, extraction, remote receipt trust and live acceptance remain blocked. Existing synthetic fixtures remain explicitly synthetic.

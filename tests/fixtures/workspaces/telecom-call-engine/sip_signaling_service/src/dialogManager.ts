/**
 * SIP Dialog Manager & Session Coordinator (RFC 3261 Section 12 & Section 14)
 */

import { SipAddressHeader, SipCSeqHeader, SipMethod, SipRequest, SipResponse, SipUri, parseSipUri } from './types/sipMessages';
import { DialogState, SipDialog } from './types/dialogTypes';
import { DialogNotFoundError, SipProtocolError } from '../../src/common/errors';

export class DialogManager {
  private readonly dialogs: Map<string, SipDialog> = new Map();
  private readonly pendingReInvites: Set<string> = new Set(); // dialogId

  constructor() {}

  /**
   * Generates composite dialog key
   */
  public static buildDialogId(callId: string, localTag: string, remoteTag: string): string {
    return `${callId}:${localTag}:${remoteTag}`;
  }

  /**
   * Creates or updates a dialog from an initial INVITE / 18x / 200 OK message
   */
  public createOrUpdateDialog(
    tenantId: string,
    message: SipResponse | SipRequest,
    role: 'UAC' | 'UAS'
  ): SipDialog {
    const callId = message.headers.callId;
    let localTag = '';
    let remoteTag = '';
    let localUri: SipUri;
    let remoteUri: SipUri;
    let remoteTarget: SipUri;
    let localCSeq = 1;
    let remoteCSeq = 0;
    let routeSet: SipAddressHeader[] = [];

    if (role === 'UAC') {
      // UAC: local is From, remote is To
      localTag = message.headers.from?.tag ?? '';
      remoteTag = message.headers.to?.tag ?? '';
      localUri = message.headers.from?.uri ?? parseSipUri('sip:caller@example.com');
      remoteUri = message.headers.to?.uri ?? parseSipUri('sip:callee@example.com');
      
      // Remote target is the Contact header from UAS response
      if (message.headers.contact && message.headers.contact.length > 0) {
        remoteTarget = message.headers.contact[0].uri;
      } else {
        remoteTarget = remoteUri;
      }
      localCSeq = message.headers.cseq.sequenceNumber;

      // For UAC, route set is the list of Record-Route headers preserved in order
      if (message.headers.recordRoute) {
        routeSet = [...message.headers.recordRoute];
      }
    } else {
      // UAS: local is To, remote is From
      localTag = message.headers.to?.tag ?? '';
      remoteTag = message.headers.from?.tag ?? '';
      localUri = message.headers.to?.uri ?? parseSipUri('sip:callee@example.com');
      remoteUri = message.headers.from?.uri ?? parseSipUri('sip:caller@example.com');

      if (message.headers.contact && message.headers.contact.length > 0) {
        remoteTarget = message.headers.contact[0].uri;
      } else {
        remoteTarget = remoteUri;
      }
      remoteCSeq = message.headers.cseq.sequenceNumber;

      // For UAS, route set is constructed by reversing the Record-Route headers received
      if (message.headers.recordRoute) {
        routeSet = [...message.headers.recordRoute].reverse();
      }
    }

    const dialogId = DialogManager.buildDialogId(callId, localTag, remoteTag);
    const existing = this.dialogs.get(dialogId);

    let state: DialogState = 'EARLY';
    if (!message.isRequest && (message as SipResponse).statusCode === 200) {
      state = 'CONFIRMED';
    } else if (existing?.state === 'CONFIRMED') {
      state = 'CONFIRMED';
    }

    const dialog: SipDialog = {
      dialogId,
      tenantId,
      callId,
      state,
      localTag,
      remoteTag,
      localUri,
      remoteUri,
      remoteTarget,
      localCSeq: existing ? existing.localCSeq : localCSeq,
      remoteCSeq: existing ? Math.max(existing.remoteCSeq, remoteCSeq) : remoteCSeq,
      routeSet: existing?.routeSet.length ? existing.routeSet : routeSet,
      secure: localUri.scheme === 'sips',
      sessionExpiresMs: 1800000, // 30 minutes default
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };

    this.dialogs.set(dialogId, dialog);
    return dialog;
  }

  /**
   * Retrieves a dialog enforcing tenant scoping
   */
  public getDialog(tenantId: string, dialogId: string): SipDialog | undefined {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) {
      return undefined;
    }
    if (dialog.tenantId !== tenantId) {
      return undefined; // Strictly enforce multi-tenant isolation
    }
    return dialog;
  }

  /**
   * Validates incoming CSeq number to reject replayed or out-of-order requests
   */
  public validateAndUpdateRemoteCSeq(dialogId: string, cseq: number): boolean {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) {
      throw new DialogNotFoundError(dialogId);
    }
    if (cseq <= dialog.remoteCSeq) {
      return false; // Out-of-order or replayed request
    }
    dialog.remoteCSeq = cseq;
    dialog.updatedAt = Date.now();
    return true;
  }

  /**
   * Generates the next local CSeq for mid-dialog requests
   */
  public nextLocalCSeq(dialogId: string): number {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) {
      throw new DialogNotFoundError(dialogId);
    }
    dialog.localCSeq += 1;
    dialog.updatedAt = Date.now();
    return dialog.localCSeq;
  }

  /**
   * Constructs mid-dialog request headers (Request-URI, Route set, CSeq, Tags)
   * Follows RFC 3261 Section 12.2.1.1 (Loose Routing vs Strict Routing)
   */
  public createMidDialogRequest(
    dialogId: string,
    method: SipMethod
  ): { requestUri: SipUri; routeHeaders: SipAddressHeader[]; cseq: SipCSeqHeader } {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) {
      throw new DialogNotFoundError(dialogId);
    }

    const cseq: SipCSeqHeader = {
      sequenceNumber: this.nextLocalCSeq(dialogId),
      method,
    };

    let requestUri = { ...dialog.remoteTarget };
    let routeHeaders: SipAddressHeader[] = [];

    if (dialog.routeSet.length === 0) {
      requestUri = { ...dialog.remoteTarget };
      routeHeaders = [];
    } else {
      const firstRoute = dialog.routeSet[0];
      const hasLr = 'lr' in firstRoute.uri.parameters || firstRoute.uri.parameters['lr'] !== undefined;

      if (hasLr) {
        // Loose routing: Request-URI is remote target, Route header is complete route set
        requestUri = { ...dialog.remoteTarget };
        routeHeaders = [...dialog.routeSet];
      } else {
        // Strict routing: Request-URI is first route, Route header contains remaining routes + remoteTarget
        requestUri = { ...firstRoute.uri };
        routeHeaders = [
          ...dialog.routeSet.slice(1),
          { uri: dialog.remoteTarget, params: {} },
        ];
      }
    }

    return { requestUri, routeHeaders, cseq };
  }

  /**
   * Handles re-INVITE collision detection (Glare - RFC 3261 Section 14.1 / 14.2)
   */
  public handleReInvite(dialogId: string, isCallIdOwner: boolean = true): {
    allow: boolean;
    httpStatus?: number;
    retryAfterSec?: number;
  } {
    if (this.pendingReInvites.has(dialogId)) {
      // Glare condition: another re-INVITE is pending
      const retryAfterSec = isCallIdOwner
        ? 2.1 + Math.random() * 1.9 // 2.1 to 4.0 seconds for Call-ID owner
        : Math.random() * 2.0;       // 0.0 to 2.0 seconds for non-owner

      return {
        allow: false,
        httpStatus: 491, // 491 Request Pending
        retryAfterSec: parseFloat(retryAfterSec.toFixed(3)),
      };
    }

    this.pendingReInvites.add(dialogId);
    return { allow: true };
  }

  /**
   * Concludes pending re-INVITE transaction
   */
  public completeReInvite(dialogId: string): void {
    this.pendingReInvites.delete(dialogId);
  }

  /**
   * Terminates and evicts dialog
   */
  public terminateDialog(tenantId: string, dialogId: string): void {
    const dialog = this.getDialog(tenantId, dialogId);
    if (dialog) {
      dialog.state = 'TERMINATED';
      dialog.updatedAt = Date.now();
      this.pendingReInvites.delete(dialogId);
      this.dialogs.delete(dialogId);
    }
  }

  /**
   * Returns count of active dialogs for tenant
   */
  public getActiveDialogCount(tenantId: string): number {
    let count = 0;
    for (const dialog of this.dialogs.values()) {
      if (dialog.tenantId === tenantId && dialog.state !== 'TERMINATED') {
        count++;
      }
    }
    return count;
  }

  public clear(): void {
    this.dialogs.clear();
    this.pendingReInvites.clear();
  }
}

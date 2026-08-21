/**
 * RFC 3515 SIP REFER & RFC 3891 Replaces Call Transfer Coordinator
 */

import crypto from 'node:crypto';
import { DialogManager } from './dialogManager';
import { SipRequest, parseSipUri, formatSipUri } from './types/sipMessages';
import { DialogNotFoundError, SipProtocolError } from '../../src/common/errors';

export type TransferType = 'BLIND' | 'ATTENDED';

export enum TransferState {
  IDLE = 'IDLE',
  REFER_SENT = 'REFER_SENT',
  REFER_ACCEPTED = 'REFER_ACCEPTED',         // 202 Accepted received
  TRANSFER_IN_PROGRESS = 'TRANSFER_IN_PROGRESS', // NOTIFY 100/180 received
  TRANSFER_COMPLETED = 'TRANSFER_COMPLETED',     // NOTIFY 200 OK received
  TRANSFER_FAILED = 'TRANSFER_FAILED'            // NOTIFY 4xx-6xx or REFER error
}

export interface BlindTransferOptions {
  tenantId: string;
  transferorDialogId: string;
  targetUri: string; // e.g. "sip:bob@example.com"
  referredByUri?: string;
}

export interface AttendedTransferOptions {
  tenantId: string;
  transfereeDialogId: string;   // Leg A-B
  consultationDialogId: string; // Leg A-C
  targetUri?: string;
}

export interface ActiveTransferRecord {
  transferId: string;
  type: TransferType;
  state: TransferState;
  tenantId: string;
  transferorDialogId: string;
  targetUri: string;
  replacesHeader?: string;
  consultationDialogId?: string;
  createdAt: number;
  updatedAt: number;
}

export class CallTransferCoordinator {
  private readonly activeTransfers: Map<string, ActiveTransferRecord> = new Map();

  constructor(private readonly dialogManager: DialogManager) {}

  /**
   * Initiates RFC 3515 Blind Transfer
   */
  public initiateBlindTransfer(options: BlindTransferOptions): { transferId: string; referRequest: SipRequest } {
    const dialog = this.dialogManager.getDialog(options.tenantId, options.transferorDialogId);
    if (!dialog) {
      throw new DialogNotFoundError(options.transferorDialogId);
    }

    const transferId = `trans_${crypto.randomUUID()}`;
    const { requestUri, routeHeaders, cseq } = this.dialogManager.createMidDialogRequest(
      options.transferorDialogId,
      'REFER'
    );

    const referRequest: SipRequest = {
      isRequest: true,
      method: 'REFER',
      requestUri,
      version: '2.0',
      headers: {
        via: [],
        from: { uri: dialog.localUri, tag: dialog.localTag, params: {} },
        to: { uri: dialog.remoteUri, tag: dialog.remoteTag, params: {} },
        callId: dialog.callId,
        cseq,
        maxForwards: 70,
        route: routeHeaders,
        referTo: { uri: parseSipUri(options.targetUri), params: {} },
        referredBy: options.referredByUri ? { uri: parseSipUri(options.referredByUri), params: {} } : undefined,
        contentLength: 0,
        custom: {
          'X-Transfer-Id': transferId,
        },
      },
    };

    const record: ActiveTransferRecord = {
      transferId,
      type: 'BLIND',
      state: TransferState.REFER_SENT,
      tenantId: options.tenantId,
      transferorDialogId: options.transferorDialogId,
      targetUri: options.targetUri,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.activeTransfers.set(transferId, record);
    return { transferId, referRequest };
  }

  /**
   * Initiates RFC 3891 Attended Transfer with Replaces Header
   */
  public initiateAttendedTransfer(options: AttendedTransferOptions): { transferId: string; referRequest: SipRequest } {
    const transfereeDialog = this.dialogManager.getDialog(options.tenantId, options.transfereeDialogId);
    if (!transfereeDialog) {
      throw new DialogNotFoundError(options.transfereeDialogId);
    }

    const consultDialog = this.dialogManager.getDialog(options.tenantId, options.consultationDialogId);
    if (!consultDialog) {
      throw new DialogNotFoundError(options.consultationDialogId);
    }

    const transferId = `trans_att_${crypto.randomUUID()}`;
    const replacesParam = `${consultDialog.callId};to-tag=${consultDialog.remoteTag};from-tag=${consultDialog.localTag}`;
    const targetHost = consultDialog.remoteTarget.host;
    const targetUser = consultDialog.remoteTarget.user ?? 'target';
    const targetUriWithReplaces = options.targetUri ?? `sip:${targetUser}@${targetHost}`;
    
    // Construct Refer-To URI with embedded Replaces header
    const parsedTarget = parseSipUri(targetUriWithReplaces);
    parsedTarget.headers['Replaces'] = replacesParam;

    const { requestUri, routeHeaders, cseq } = this.dialogManager.createMidDialogRequest(
      options.transfereeDialogId,
      'REFER'
    );

    const referRequest: SipRequest = {
      isRequest: true,
      method: 'REFER',
      requestUri,
      version: '2.0',
      headers: {
        via: [],
        from: { uri: transfereeDialog.localUri, tag: transfereeDialog.localTag, params: {} },
        to: { uri: transfereeDialog.remoteUri, tag: transfereeDialog.remoteTag, params: {} },
        callId: transfereeDialog.callId,
        cseq,
        maxForwards: 70,
        route: routeHeaders,
        referTo: { uri: parsedTarget, params: {} },
        replaces: replacesParam,
        contentLength: 0,
        custom: {
          'X-Transfer-Id': transferId,
        },
      },
    };

    const record: ActiveTransferRecord = {
      transferId,
      type: 'ATTENDED',
      state: TransferState.REFER_SENT,
      tenantId: options.tenantId,
      transferorDialogId: options.transfereeDialogId,
      consultationDialogId: options.consultationDialogId,
      targetUri: targetUriWithReplaces,
      replacesHeader: replacesParam,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.activeTransfers.set(transferId, record);
    return { transferId, referRequest };
  }

  /**
   * Processes response to initial REFER request
   */
  public handleReferResponse(transferId: string, statusCode: number): void {
    const record = this.activeTransfers.get(transferId);
    if (!record) {
      throw new SipProtocolError(`Transfer session not found: ${transferId}`, 481);
    }

    if (statusCode === 202 || statusCode === 200) {
      record.state = TransferState.REFER_ACCEPTED;
      record.updatedAt = Date.now();
    } else {
      record.state = TransferState.TRANSFER_FAILED;
      record.updatedAt = Date.now();
    }
  }

  /**
   * Parses RFC 3891 Replaces header value
   * Format: callId;to-tag=xxx;from-tag=yyy[;early-only]
   */
  public static parseReplacesHeader(headerValue: string): {
    callId: string;
    toTag?: string;
    fromTag?: string;
    earlyOnly: boolean;
  } {
    const parts = headerValue.split(';');
    const callId = parts[0].trim();
    let toTag: string | undefined;
    let fromTag: string | undefined;
    let earlyOnly = false;

    for (let i = 1; i < parts.length; i++) {
      const [k, v] = parts[i].split('=');
      const key = k.trim().toLowerCase();
      if (key === 'to-tag') {
        toTag = v ? v.trim() : undefined;
      } else if (key === 'from-tag') {
        fromTag = v ? v.trim() : undefined;
      } else if (key === 'early-only') {
        earlyOnly = true;
      }
    }

    return { callId, toTag, fromTag, earlyOnly };
  }

  /**
   * Processes incoming NOTIFY event body reporting transfer progress
   */
  public handleNotify(
    transferId: string,
    notifyBody: string,
    subscriptionState: string = 'active'
  ): {
    isComplete: boolean;
    success: boolean;
    statusCode: number;
    shouldTeardownTransferorLeg: boolean;
  } {
    const record = this.activeTransfers.get(transferId);
    if (!record) {
      throw new SipProtocolError(`Transfer session not found: ${transferId}`, 481);
    }

    // Extract status code from NOTIFY message/sipfrag body (e.g. "SIP/2.0 100 Trying", "SIP/2.0 200 OK")
    const match = notifyBody.match(/SIP\/2\.0\s+(\d{3})/i);
    const statusCode = match ? parseInt(match[1], 10) : 100;

    let isComplete = false;
    let success = false;
    let shouldTeardownTransferorLeg = false;

    if (statusCode >= 100 && statusCode < 200) {
      record.state = TransferState.TRANSFER_IN_PROGRESS;
    } else if (statusCode >= 200 && statusCode < 300) {
      record.state = TransferState.TRANSFER_COMPLETED;
      isComplete = true;
      success = true;
      shouldTeardownTransferorLeg = true;
    } else {
      record.state = TransferState.TRANSFER_FAILED;
      isComplete = true;
      success = false;
    }

    if (subscriptionState.toLowerCase().includes('terminated')) {
      isComplete = true;
    }

    record.updatedAt = Date.now();

    return {
      isComplete,
      success,
      statusCode,
      shouldTeardownTransferorLeg,
    };
  }

  public getTransfer(transferId: string): ActiveTransferRecord | undefined {
    return this.activeTransfers.get(transferId);
  }

  public clear(): void {
    this.activeTransfers.clear();
  }
}

#!/usr/bin/env python3
"""Adversarial Oracle Bridge: executes Python's canonical serialization and validation.
Used by adversarial_agentHarnessContracts.test.ts to verify cross-runtime parity.
"""
from __future__ import annotations

import hashlib
import json
import sys
from typing import Any

MAX_BYTES = 65_536


class ContractError(ValueError):
    pass


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ContractError(code)


def canonical(value: Any) -> bytes:
    pending = [value]
    nodes = 0
    while pending:
        item = pending.pop()
        nodes += 1
        require(nodes <= MAX_BYTES, 'PAYLOAD_TOO_LARGE')
        if type(item) is dict:
            require(all(type(key) is str for key in item), 'INVALID_JSON')
            pending.extend(item.values())
        elif type(item) is list:
            pending.extend(item)
        else:
            require(type(item) in (str, int, bool, type(None)), 'INVALID_JSON')
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(',', ':'),
                             ensure_ascii=True, allow_nan=False).encode('ascii')
    except (TypeError, ValueError, RecursionError):
        raise ContractError('INVALID_JSON') from None
    require(len(encoded) <= MAX_BYTES, 'PAYLOAD_TOO_LARGE')
    return encoded


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def load_packet(raw: bytes) -> dict:
    require(len(raw) <= MAX_BYTES, 'PAYLOAD_TOO_LARGE')
    try:
        packet = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_pairs)
    except ContractError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise ContractError('INVALID_JSON') from None
    canonical(packet)
    return packet


def canonical_result(value: Any) -> dict:
    encoded = canonical(value)
    return {
        'ok': True,
        'canonical': encoded.decode('ascii'),
        'digest': 'sha256:' + hashlib.sha256(encoded).hexdigest(),
        'length': len(encoded),
    }


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else 'canonical'
    raw_input = sys.stdin.buffer.read()

    if mode == 'canonical':
        try:
            value = json.loads(raw_input.decode('utf-8'))
            print(json.dumps(canonical_result(value)))
            return 0
        except ContractError as err:
            print(json.dumps({'ok': False, 'error': str(err)}))
            return 0
        except Exception as err:
            print(json.dumps({'ok': False, 'error': type(err).__name__ + ': ' + str(err)}))
            return 0

    elif mode == 'canonical_batch':
        try:
            values = json.loads(raw_input.decode('utf-8'))
            require(type(values) is list, 'INVALID_JSON')
            print(json.dumps([canonical_result(value) for value in values]))
            return 0
        except ContractError as err:
            print(json.dumps({'ok': False, 'error': str(err)}))
            return 0
        except Exception as err:
            print(json.dumps({'ok': False, 'error': type(err).__name__ + ': ' + str(err)}))
            return 0

    elif mode == 'load_packet':
        try:
            packet = load_packet(raw_input)
            encoded = canonical(packet)
            digest = hashlib.sha256(encoded).hexdigest()
            print(json.dumps({
                'ok': True,
                'packet': packet,
                'canonical': encoded.decode('ascii'),
                'digest': 'sha256:' + digest
            }))
            return 0
        except ContractError as err:
            print(json.dumps({'ok': False, 'error': str(err)}))
            return 0
        except Exception as err:
            print(json.dumps({'ok': False, 'error': type(err).__name__ + ': ' + str(err)}))
            return 0

    else:
        print(f"Unknown mode: {mode}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

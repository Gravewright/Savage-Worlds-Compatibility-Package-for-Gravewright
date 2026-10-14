"""Deterministic clocks; the native host owns transactions and permissions.

No catalog, dice, resource charge, network call or document lookup is performed.
Only explicit user-configured clocks and package-owned temporary states change.
"""
import math

MAX_CLOCK = 10000
MAX_ENTRIES = 128
TEMPORARY_STATES = ('distracted', 'vulnerable')


def _integer(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
        if not math.isfinite(number) or number != int(number) or not 0 <= number <= MAX_CLOCK:
            return None
        return int(number)
    except (ValueError, OverflowError):
        return None


def _owner_matches(clock, event):
    owner = clock.get('owner', 'self')
    if owner == 'self':
        return event.get('isCurrent') is True
    if owner != 'source':
        return False
    if clock.get('sourceTokenId'):
        return str(clock['sourceTokenId']) == event.get('tokenId')
    if clock.get('sourceActorId'):
        return str(clock['sourceActorId']) == event.get('actorId')
    return False


def _matches(clock, event):
    phase = clock.get('phase')
    if phase == 'round':
        return event.get('phase') == 'end' and event.get('roundBoundary') is True
    return phase in ('start', 'end') and phase == event.get('phase') and _owner_matches(clock, event)


def _key(event, collection, index, phase):
    document = event.get('documentKey')
    if not isinstance(document, tuple):
        return None
    key = ('swade-clock', document, collection, index, phase)
    try:
        hash(key)
        return key
    except TypeError:
        return None


def _claim(event, collection, index, phase):
    key = _key(event, collection, index, phase)
    if key is None:
        return False
    clocks = event.get('clockKeys')
    if not isinstance(clocks, set) or key in clocks:
        return False
    clocks.add(key)
    return True


def _advance_states(data, event):
    states, clocks = data.get('status'), data.get('statusClocks')
    if not isinstance(states, dict) or not isinstance(clocks, dict):
        return False
    changed = False
    for name in TEMPORARY_STATES:
        clock = clocks.get(name)
        if states.get(name) is not True or not isinstance(clock, dict) or _integer(clock.get('remaining')) is None:
            continue
        if clock.get('awaitingStart') is True:
            if event.get('phase') == 'start' and _owner_matches(clock, event) and _claim(event, 'status', name, 'arm'):
                clock['awaitingStart'] = False
                changed = True
            continue
        if not _matches(clock, event) or not _claim(event, 'status', name, 'tick'):
            continue
        clock['remaining'] = max(0, _integer(clock['remaining']) - 1)
        if clock['remaining'] == 0:
            states[name] = False
            del clocks[name]
        changed = True
    return changed


def _advance_effects(data, event):
    entries = data.get('effects')
    if not isinstance(entries, list):
        return False
    changed = False
    for index, entry in enumerate(entries[:MAX_ENTRIES]):
        if not isinstance(entry, dict):
            continue
        payload = entry.get('data')
        if not isinstance(payload, dict) or payload.get('active') is not True:
            continue
        remaining = _integer(payload.get('remaining'))
        if remaining is None or not _matches(payload, event) or not _claim(event, 'effects', index, 'tick'):
            continue
        payload['remaining'] = max(0, remaining - 1)
        if payload['remaining'] == 0:
            payload['active'] = False
        changed = True
    return changed


def _advance_powers(data, event):
    entries = data.get('activePowers')
    if not isinstance(entries, list) or event.get('phase') != 'end' or event.get('isCurrent') is not True:
        return False
    changed = False
    for index, entry in enumerate(entries[:MAX_ENTRIES]):
        if not isinstance(entry, dict) or entry.get('active') is not True:
            continue
        duration, remaining = _integer(entry.get('durationRounds')), _integer(entry.get('remainingRounds'))
        if duration in (None, 0) or remaining is None or not _claim(event, 'activePowers', index, 'tick'):
            continue
        entry['remainingRounds'] = max(0, remaining - 1)
        if entry['remainingRounds'] == 0:
            entry['active'] = False
        changed = True
    return changed


def advance_effects(data, event):
    """Mutate an isolated native sheet copy and return whether to persist it.

    Skipped turns also advance clocks. The periodic flag concerns actions and
    random rolls, neither of which this provider performs. Shared clockKeys
    prevent a linked actor from ticking twice in the same native command.
    """
    if not isinstance(data, dict) or not isinstance(event, dict) or event.get('phase') not in ('start', 'end'):
        return False
    status = data.get('status')
    holding = isinstance(status, dict) and status.get('holding') is True and (status.get('shaken') is True or status.get('stunned') is True or status.get('incapacitated') is True)
    if holding:
        status['holding'] = False
    if event.get('phase') == 'start' and event.get('roundBoundary') is True and isinstance(data.get('combat'), dict) and data['combat'].get('cardInitiative') is True:
        # The package's card tracker arms the new first actor after dealing and
        # sorting; the native boundary still refers to the previous card order.
        return holding
    states = _advance_states(data, event)
    effects = _advance_effects(data, event)
    powers = _advance_powers(data, event)
    return holding or states or effects or powers

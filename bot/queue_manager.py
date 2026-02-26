"""
Async download queue manager.

Uses two layers of semaphores:
  - A global semaphore to cap total concurrent downloads.
  - A per-user semaphore to prevent a single user from hogging capacity.
"""
import asyncio
from collections import defaultdict

from bot.config import MAX_CONCURRENT_DOWNLOADS

# One active download per user at a time
_MAX_PER_USER = 1

_global_sem: asyncio.Semaphore | None = None
_user_sems: dict[int, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(_MAX_PER_USER))

# Track active count for /status reporting
_active_count: int = 0
_active_lock: asyncio.Lock | None = None


def _get_global_sem() -> asyncio.Semaphore:
    global _global_sem
    if _global_sem is None:
        _global_sem = asyncio.Semaphore(MAX_CONCURRENT_DOWNLOADS)
    return _global_sem


def _get_active_lock() -> asyncio.Lock:
    global _active_lock
    if _active_lock is None:
        _active_lock = asyncio.Lock()
    return _active_lock


async def acquire(user_id: int) -> None:
    """Acquire both the user-level and global semaphores."""
    global _active_count
    await _user_sems[user_id].acquire()
    await _get_global_sem().acquire()
    async with _get_active_lock():
        _active_count += 1


def release(user_id: int) -> None:
    """Release both semaphores."""
    global _active_count
    _user_sems[user_id].release()
    _get_global_sem().release()
    # Use call_soon_threadsafe-safe decrement
    # (release is always called from async context via finally blocks)
    asyncio.get_event_loop().call_soon(lambda: _decrement())


def _decrement() -> None:
    global _active_count
    _active_count = max(0, _active_count - 1)


def active_downloads() -> int:
    return _active_count


def queue_depth(user_id: int | None = None) -> int:
    """Rough estimate of pending downloads waiting for a slot."""
    sem = _get_global_sem()
    # Semaphore._value is CPython implementation detail, but widely used
    capacity = getattr(sem, "_value", MAX_CONCURRENT_DOWNLOADS)
    waiting = MAX_CONCURRENT_DOWNLOADS - capacity
    return max(0, waiting)

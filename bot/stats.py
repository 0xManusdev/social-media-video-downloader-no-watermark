"""
In-memory statistics tracker for the bot.
Reset on each restart — no persistence needed for now.
"""
import time
from collections import defaultdict
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class BotStats:
    started_at: float = field(default_factory=time.time)
    total_attempted: int = 0
    total_succeeded: int = 0
    total_failed: int = 0
    total_too_large: int = 0

    # platform_name -> count
    by_platform: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    # user_id -> count
    by_user: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    # Unique users seen
    all_users: set[int] = field(default_factory=set)

    _lock: Lock = field(default_factory=Lock, repr=False, compare=False)

    def record_user(self, user_id: int) -> None:
        with self._lock:
            self.all_users.add(user_id)

    def record_attempt(self) -> None:
        with self._lock:
            self.total_attempted += 1

    def record_success(self, platform: str, user_id: int) -> None:
        with self._lock:
            self.total_succeeded += 1
            self.by_platform[platform] += 1
            self.by_user[user_id] += 1

    def record_failure(self) -> None:
        with self._lock:
            self.total_failed += 1

    def record_too_large(self) -> None:
        with self._lock:
            self.total_too_large += 1
            self.total_failed += 1

    def uptime_str(self) -> str:
        elapsed = int(time.time() - self.started_at)
        h, rem = divmod(elapsed, 3600)
        m, s = divmod(rem, 60)
        return f"{h}h {m}m {s}s"

    def top_platforms(self, n: int = 5) -> list[tuple[str, int]]:
        return sorted(self.by_platform.items(), key=lambda x: x[1], reverse=True)[:n]

    def summary_text(self) -> str:
        lines = [
            "📊 <b>Bot Statistics</b>\n",
            f"⏱ Uptime: <b>{self.uptime_str()}</b>",
            f"👥 Total Users: <b>{len(self.all_users)}</b>",
            f"📥 Attempted: <b>{self.total_attempted}</b>",
            f"✅ Succeeded: <b>{self.total_succeeded}</b>",
            f"❌ Failed: <b>{self.total_failed}</b>",
            f"📦 Too large: <b>{self.total_too_large}</b>",
        ]
        top = self.top_platforms()
        if top:
            lines.append("\n🏆 <b>Top platforms:</b>")
            for platform, count in top:
                lines.append(f"  • {platform}: {count}")
        return "\n".join(lines)


# Singleton instance shared across the bot
stats = BotStats()

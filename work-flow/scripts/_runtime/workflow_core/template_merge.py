import difflib
import re


HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*\r?\n?$")
FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")


def _line_changes(base_lines, branch_lines):
    matcher = difflib.SequenceMatcher(a=base_lines, b=branch_lines, autojunk=False)
    return [
        (start, end, branch_lines[branch_start:branch_end])
        for tag, start, end, branch_start, branch_end in matcher.get_opcodes()
        if tag != "equal"
    ]


def _changes_overlap(left, right):
    left_start, left_end, _ = left
    right_start, right_end, _ = right
    if left_start == left_end and right_start == right_end:
        return left_start == right_start
    if left_start == left_end:
        return right_start <= left_start < right_end
    if right_start == right_end:
        return left_start <= right_start < left_end
    return max(left_start, right_start) < min(left_end, right_end)


def _line_three_way_merge(base, current, new):
    base_lines = base.decode("utf-8").splitlines(keepends=True)
    current_lines = current.decode("utf-8").splitlines(keepends=True)
    new_lines = new.decode("utf-8").splitlines(keepends=True)
    current_changes = _line_changes(base_lines, current_lines)
    new_changes = _line_changes(base_lines, new_lines)
    merged = []
    conflicts = []
    cursor = 0
    current_index = 0
    new_index = 0
    while current_index < len(current_changes) or new_index < len(new_changes):
        current_change = current_changes[current_index] if current_index < len(current_changes) else None
        new_change = new_changes[new_index] if new_index < len(new_changes) else None
        if current_change is not None and new_change is not None and _changes_overlap(current_change, new_change):
            if current_change == new_change:
                change = current_change
                current_index += 1
                new_index += 1
            else:
                conflicts.append({
                    "base_start_line": min(current_change[0], new_change[0]) + 1,
                    "base_end_line": max(current_change[1], new_change[1]),
                })
                break
        elif new_change is None or (
            current_change is not None
            and (current_change[0], current_change[1]) < (new_change[0], new_change[1])
        ):
            change = current_change
            current_index += 1
        else:
            change = new_change
            new_index += 1
        start, end, replacement = change
        if start < cursor:
            conflicts.append({"base_start_line": start + 1, "base_end_line": end})
            break
        merged.extend(base_lines[cursor:start])
        merged.extend(replacement)
        cursor = end
    if conflicts:
        return None, conflicts
    merged.extend(base_lines[cursor:])
    return "".join(merged).encode("utf-8"), []


def _markdown_sections(content):
    lines = content.decode("utf-8").splitlines(keepends=True)
    sections = {}
    order = []
    paths = []
    current_key = ("__preamble__",)
    active_fence = None
    sections[current_key] = []
    order.append(current_key)
    for line in lines:
        fence = FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            if active_fence is None:
                active_fence = (marker[0], len(marker))
            elif marker[0] == active_fence[0] and len(marker) >= active_fence[1]:
                active_fence = None
            sections[current_key].append(line)
            continue
        if active_fence is not None:
            sections[current_key].append(line)
            continue
        match = HEADING_RE.match(line)
        if match:
            level = len(match.group(1))
            title = " ".join(match.group(2).strip().casefold().split())
            paths = paths[: level - 1]
            paths.append(title)
            current_key = tuple(paths)
            if current_key in sections:
                return None, None
            sections[current_key] = []
            order.append(current_key)
        sections[current_key].append(line)
    return order, sections


def _section_three_way_merge(base, current, new):
    base_order, base_sections = _markdown_sections(base)
    current_order, current_sections = _markdown_sections(current)
    new_order, new_sections = _markdown_sections(new)
    if not all((base_order, current_order, new_order)):
        return None, []
    if set(base_order) != set(current_order) or set(base_order) != set(new_order):
        return None, []

    current_reordered = current_order != base_order
    new_reordered = new_order != base_order
    if current_reordered and new_reordered and current_order != new_order:
        return None, [{
            "code": "section_order_conflict",
            "message": "Current rules and the new template reorder Markdown sections differently.",
        }]
    output_order = current_order if current_reordered else new_order
    merged_sections = {}
    conflicts = []
    for key in base_order:
        merged, section_conflicts = _line_three_way_merge(
            "".join(base_sections[key]).encode("utf-8"),
            "".join(current_sections[key]).encode("utf-8"),
            "".join(new_sections[key]).encode("utf-8"),
        )
        if section_conflicts:
            conflicts.append({
                "code": "section_content_conflict",
                "section": " / ".join(key),
                "hunks": section_conflicts,
            })
        else:
            merged_sections[key] = merged
    if conflicts:
        return None, conflicts
    return b"".join(merged_sections[key] for key in output_order), []


def three_way_merge(base, current, new):
    """Merge bytes conservatively, with a Markdown move-aware fallback."""
    merged, conflicts = _line_three_way_merge(base, current, new)
    if not conflicts:
        return merged, []
    section_merged, section_conflicts = _section_three_way_merge(base, current, new)
    if section_merged is not None:
        return section_merged, []
    return None, section_conflicts or conflicts

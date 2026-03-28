from __future__ import annotations

import math
import re
from typing import Any

import networkx as nx


def enhance_graph(payload: dict[str, Any]) -> dict[str, Any]:
    raw_nodes = payload.get("nodes", [])
    raw_links = payload.get("links", [])

    nodes = _normalize_nodes(raw_nodes)
    if len(nodes) < 2:
        return {"nodes": nodes, "links": _normalize_links(raw_links)}

    links = _normalize_links(raw_links)
    link_map = _build_link_map(links)
    graph = _build_graph(nodes, link_map)

    _bridge_components(graph, link_map, nodes)
    _ensure_minimum_degree(graph, link_map, nodes, target_degree=3)
    _densify_with_jaccard(graph, link_map, nodes)
    _normalize_link_relation_types(link_map, nodes)

    result_links = list(link_map.values())
    return {"nodes": nodes, "links": result_links}


def _normalize_nodes(raw_nodes: list[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_nodes:
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("id", "")).strip()
        label = str(item.get("label", "")).strip()
        if not node_id or not label or node_id in seen:
            continue
        seen.add(node_id)
        weight = item.get("weight", 1)
        try:
            weight_value = int(weight)
        except Exception:
            weight_value = 1
        output.append(
            {
                "id": node_id,
                "label": label,
                "weight": max(1, weight_value),
            }
        )
    return output


def _normalize_links(raw_links: list[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_links:
        if not isinstance(item, dict):
            continue
        source = str(item.get("source", "")).strip()
        target = str(item.get("target", "")).strip()
        if not source or not target or source == target:
            continue
        key = _pair_key(source, target)
        if key in seen:
            continue
        seen.add(key)
        relation_type = _normalize_relation_type(str(item.get("relationType", "关联")).strip() or "关联")
        confidence = item.get("confidence", None)
        output.append(
            {
                "source": source,
                "target": target,
                "relationType": relation_type,
                "confidence": confidence,
            }
        )
    return output


def _build_link_map(links: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {_pair_key(item["source"], item["target"]): item for item in links}


def _build_graph(
    nodes: list[dict[str, Any]], link_map: dict[str, dict[str, Any]]
) -> nx.Graph:
    graph = nx.Graph()
    for node in nodes:
        graph.add_node(node["id"], label=node["label"])
    for link in link_map.values():
        source = link["source"]
        target = link["target"]
        if source in graph and target in graph:
            graph.add_edge(source, target)
    return graph


def _bridge_components(
    graph: nx.Graph,
    link_map: dict[str, dict[str, Any]],
    nodes: list[dict[str, Any]],
) -> None:
    components = sorted(nx.connected_components(graph), key=len, reverse=True)
    if len(components) <= 1:
        return
    node_meta = {item["id"]: item for item in nodes}
    main_component = list(components[0])
    main_hub = _pick_hub(graph, main_component)
    if not main_hub:
        return

    for component in components[1:]:
        candidate = _pick_hub(graph, list(component))
        if not candidate or candidate == main_hub:
            continue
        label_a = node_meta.get(candidate, {}).get("label", candidate)
        label_b = node_meta.get(main_hub, {}).get("label", main_hub)
        relation_type = _guess_relation_type(label_a, label_b, fallback="跨域关联")
        _add_link(graph, link_map, candidate, main_hub, relation_type, confidence=0.52)


def _ensure_minimum_degree(
    graph: nx.Graph,
    link_map: dict[str, dict[str, Any]],
    nodes: list[dict[str, Any]],
    target_degree: int,
) -> None:
    if target_degree <= 0:
        return
    node_meta = {item["id"]: item for item in nodes}
    degree_map = dict(graph.degree())
    hubs = sorted(degree_map, key=lambda node_id: degree_map.get(node_id, 0), reverse=True)[:6]
    for node in graph.nodes:
        while graph.degree(node) < target_degree:
            best_target = _pick_best_candidate(node, graph, node_meta, hubs)
            if not best_target:
                break
            label_a = node_meta.get(node, {}).get("label", node)
            label_b = node_meta.get(best_target, {}).get("label", best_target)
            relation_type = _guess_relation_type(label_a, label_b, fallback="相关主题")
            _add_link(graph, link_map, node, best_target, relation_type, confidence=0.48)


def _densify_with_jaccard(
    graph: nx.Graph,
    link_map: dict[str, dict[str, Any]],
    nodes: list[dict[str, Any]],
) -> None:
    node_count = max(1, len(nodes))
    target_edges = min(int(math.ceil(node_count * 3.2)), max(42, int(math.ceil(node_count * 2.4))))
    if graph.number_of_edges() >= target_edges:
        return

    node_meta = {item["id"]: item for item in nodes}
    candidates = sorted(
        nx.jaccard_coefficient(graph),
        key=lambda item: item[2],
        reverse=True,
    )
    for source, target, score in candidates:
        if graph.number_of_edges() >= target_edges:
            break
        if score <= 0:
            continue
        key = _pair_key(source, target)
        if key in link_map:
            continue
        label_a = node_meta.get(source, {}).get("label", source)
        label_b = node_meta.get(target, {}).get("label", target)
        relation_type = _guess_relation_type(label_a, label_b, fallback="推断关联")
        confidence = round(min(0.86, 0.45 + score * 0.45), 3)
        _add_link(graph, link_map, source, target, relation_type, confidence=confidence)


def _normalize_link_relation_types(
    link_map: dict[str, dict[str, Any]],
    nodes: list[dict[str, Any]],
) -> None:
    node_meta = {item["id"]: item for item in nodes}
    for link in link_map.values():
        source = link.get("source", "")
        target = link.get("target", "")
        left_label = node_meta.get(source, {}).get("label", source)
        right_label = node_meta.get(target, {}).get("label", target)
        relation = str(link.get("relationType", "关联"))
        normalized = _normalize_relation_type(relation)
        if normalized == "实现/调用" and not _is_callable_relation_pair(left_label, right_label):
            normalized = _guess_relation_type(left_label, right_label, fallback="相关主题")
        if normalized in {"关联", "推断关联", "相关主题", "跨域关联"}:
            normalized = _guess_relation_type(left_label, right_label, fallback="并列对比")
        link["relationType"] = normalized


def _pick_hub(graph: nx.Graph, component_nodes: list[str]) -> str | None:
    if not component_nodes:
        return None
    return max(component_nodes, key=lambda node_id: graph.degree(node_id))


def _pick_best_candidate(
    source: str,
    graph: nx.Graph,
    node_meta: dict[str, dict[str, Any]],
    preferred_targets: list[str],
) -> str | None:
    source_label = node_meta.get(source, {}).get("label", source)
    best_target = None
    best_score = -1.0
    neighbors = set(graph.neighbors(source))

    candidates = preferred_targets + list(graph.nodes)
    seen: set[str] = set()
    for target in candidates:
        if target == source or target in neighbors or target in seen:
            continue
        seen.add(target)
        target_label = node_meta.get(target, {}).get("label", target)
        sim = _label_similarity(source_label, target_label)
        degree_bonus = min(1.0, graph.degree(target) / 8.0)
        score = sim * 0.78 + degree_bonus * 0.22
        if score > best_score:
            best_score = score
            best_target = target
    return best_target


def _label_similarity(left: str, right: str) -> float:
    left_tokens = _tokenize_label(left)
    right_tokens = _tokenize_label(right)
    if not left_tokens or not right_tokens:
        return 0.0
    inter = len(left_tokens.intersection(right_tokens))
    union = len(left_tokens.union(right_tokens))
    if union == 0:
        return 0.0
    return inter / union


def _tokenize_label(label: str) -> set[str]:
    value = label.strip().lower()
    if not value:
        return set()
    tokens: set[str] = set()
    for part in re.findall(r"[a-z0-9_+#]+|[\u4e00-\u9fff]+", value):
        if re.match(r"[\u4e00-\u9fff]+", part):
            if len(part) <= 2:
                tokens.add(part)
            else:
                for idx in range(len(part) - 1):
                    tokens.add(part[idx : idx + 2])
        else:
            tokens.add(part)
    return tokens


def _guess_relation_type(left_label: str, right_label: str, fallback: str) -> str:
    combined = f"{left_label} {right_label}"
    if _is_constraint_label(left_label) or _is_constraint_label(right_label):
        return "约束/边界"
    if _is_confusion_label(left_label) or _is_confusion_label(right_label):
        return "易混淆"
    if _is_prerequisite_label(left_label) or _is_prerequisite_label(right_label):
        return "前置依赖"
    if _is_example_label(left_label) or _is_example_label(right_label):
        return "示例"
    if any(key in combined for key in ["前置", "基础", "依赖", "准备", " prerequisite", "base"]):
        return "前置依赖"
    if any(key in combined for key in ["章", "节", "模块", "组成", "结构", "部分", "层级"]):
        return "包含"
    if _is_container_label(left_label) and _is_container_label(right_label):
        return "并列对比"
    if (_is_class_mechanism_label(left_label) and _is_member_feature_label(right_label)) or (
        _is_class_mechanism_label(right_label) and _is_member_feature_label(left_label)
    ):
        return "包含"
    if _is_callable_relation_pair(left_label, right_label):
        return "实现/调用"
    if any(key in combined for key in ["输入", "输出", "参数", "返回", "数据"]):
        return "输入输出"
    if any(key in combined for key in ["示例", "例子", "样例", "demo"]):
        return "示例"
    if any(key in combined for key in ["应用", "场景", "实战", "案例", "项目", "工程"]):
        return "应用场景"
    if _label_similarity(left_label, right_label) >= 0.42:
        return "并列对比"
    return _normalize_relation_type(fallback)


def _add_link(
    graph: nx.Graph,
    link_map: dict[str, dict[str, Any]],
    source: str,
    target: str,
    relation_type: str,
    confidence: float,
) -> None:
    if source == target:
        return
    key = _pair_key(source, target)
    if key in link_map:
        return
    graph.add_edge(source, target)
    link_map[key] = {
        "source": source,
        "target": target,
        "relationType": _normalize_relation_type(relation_type),
        "confidence": confidence,
    }


def _pair_key(left: str, right: str) -> str:
    return f"{left}::{right}" if left <= right else f"{right}::{left}"


def _normalize_relation_type(value: str) -> str:
    text = value.strip()
    if not text:
        return "关联"
    if "前置" in text or "依赖" in text:
        return "前置依赖"
    if "包含" in text or "组成" in text or "属于" in text or "层级" in text:
        return "包含"
    if "并列" in text or "对比" in text or "区别" in text:
        return "并列对比"
    if "实现" in text or "调用" in text or "机制" in text:
        return "实现/调用"
    if "输入" in text or "输出" in text or "参数" in text or "返回" in text:
        return "输入输出"
    if "混淆" in text or "误区" in text or "易错" in text:
        return "易混淆"
    if "应用" in text or "场景" in text or "实战" in text:
        return "应用场景"
    if "约束" in text or "边界" in text or "限制" in text:
        return "约束/边界"
    if "示例" in text or "例子" in text or "样例" in text:
        return "示例"
    return text


def _contains_any(value: str, keywords: list[str]) -> bool:
    text = value.strip().lower()
    if not text:
        return False
    return any(keyword in text for keyword in keywords)


def _is_constraint_label(value: str) -> bool:
    return _contains_any(value, ["不能", "不可", "限制", "约束", "边界", "风险", "副作用", "破坏"])


def _is_confusion_label(value: str) -> bool:
    return _contains_any(value, ["混淆", "误区", "易错", "易混"])


def _is_prerequisite_label(value: str) -> bool:
    return _contains_any(value, ["前置", "基础", "准备", "先学", "依赖"])


def _is_example_label(value: str) -> bool:
    return _contains_any(value, ["示例", "例子", "样例", "案例"])


def _is_container_label(value: str) -> bool:
    return _contains_any(value, ["vector", "list", "map", "set", "容器", "迭代器", "算法"])


def _is_class_mechanism_label(value: str) -> bool:
    return _contains_any(value, ["类机制", "对象模型", "模板机制", "面向对象", "类"])


def _is_member_feature_label(value: str) -> bool:
    return _contains_any(value, ["构造函数", "析构函数", "拷贝", "赋值", "重载", "友元", "继承", "多态", "初始化"])


def _is_callable_label(value: str) -> bool:
    return _contains_any(value, ["函数", "方法", "接口", "api", "调用", "回调", "operator", "操作符"])


def _is_callable_relation_pair(left_label: str, right_label: str) -> bool:
    return _is_callable_label(left_label) and _is_callable_label(right_label)

# Workflow State

---workflow-state-json-v1---
{
  "active_task_id": "be50d92f-59cc-4b99-8286-31b29374c38b",
  "completed_tasks": {},
  "mode": "adopt",
  "recent_events": [
    {
      "at": "2026-08-19T04:36:26Z",
      "detail": {
        "kind": "code",
        "level": "L4",
        "task_id": "be50d92f-59cc-4b99-8286-31b29374c38b"
      },
      "name": "task.add"
    },
    {
      "at": "2026-08-19T04:41:18Z",
      "detail": {
        "task_id": "be50d92f-59cc-4b99-8286-31b29374c38b",
        "to": "planned"
      },
      "name": "task.transition"
    },
    {
      "at": "2026-08-19T04:41:18Z",
      "detail": {
        "task_id": "be50d92f-59cc-4b99-8286-31b29374c38b",
        "to": "approved"
      },
      "name": "task.transition"
    },
    {
      "at": "2026-08-19T04:41:39Z",
      "detail": {
        "kind": "test",
        "level": "L3",
        "task_id": "e842278c-e053-45be-aa35-a144f49b57ab"
      },
      "name": "task.add"
    },
    {
      "at": "2026-08-19T04:41:40Z",
      "detail": {
        "kind": "risk",
        "level": "L4",
        "task_id": "71d4428f-ff22-4e8d-bdb8-f09efcb0221b"
      },
      "name": "task.add"
    },
    {
      "at": "2026-08-19T04:42:02Z",
      "detail": {
        "task_id": "be50d92f-59cc-4b99-8286-31b29374c38b",
        "to": "implementing"
      },
      "name": "task.transition"
    },
    {
      "at": "2026-08-19T07:34:37Z",
      "detail": {
        "from": "ws-b99f6bf3046785f7bbfef1d5",
        "to": "ws-fd23a02ea0f2db963627743a"
      },
      "name": "workspace.migrate"
    }
  ],
  "revision": 7,
  "runtime_version": "1.2.0",
  "schema_version": 1,
  "status": "initialized",
  "tasks": {
    "71d4428f-ff22-4e8d-bdb8-f09efcb0221b": {
      "display_seq": "0002",
      "kind": "risk",
      "level": "L4",
      "phase": "intake",
      "state_ref": "work-flow/docs/requirements/0002_炸金花生产发布与回滚审计_L4/task-state.md",
      "state_sha256": "a61c19dffa627b1ae0819693d9de935f5eafff02c2f9c872df564fe4b53c7fa9",
      "task_id": "71d4428f-ff22-4e8d-bdb8-f09efcb0221b",
      "title": "炸金花生产发布与回滚审计",
      "updated_at": "2026-08-19T04:41:40Z"
    },
    "be50d92f-59cc-4b99-8286-31b29374c38b": {
      "approvals": {
        "implementation_authorization": "user-confirmed-2026-08-19-develop-test-commit-deploy",
        "intent_and_scope": "4cf4d13a72fa667c0adaf75c753a3c76a15fc916b275ac98cd6d76a1ed5186ce",
        "l4": {
          "audit_result_ref": "work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/result.md",
          "backup_ref": "docs/superpowers/plans/2026-08-19-zhajinhua-gameplay-closure-plan.md#task-10-review-publish-deploy-and-verify-production",
          "external_write_scope": "GitHub SorryMcDonald/SorryMcDonald.github.io branch huang and Zhajinhua files/services on 47.102.218.42 only",
          "monitoring_ref": "HTTPS health, WSS flow, systemd units, Nginx and Cloudflared health",
          "post_action_validation_ref": "work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/release.md",
          "risk_confirmation": "用户明确授权开发、测试、huang分支推送及目标炸金花生产部署",
          "rollback_ref": "restore previous application release symlink and service state",
          "stop_condition": "stop promotion and restore prior release on any local gate, candidate check, HTTPS, WSS, auth, room, or shared ingress health failure",
          "target_environment": "production Ubuntu 24.04 LTS",
          "target_object": "huang branch exact revision and Zhajinhua application release",
          "target_system": "crazythursdayplay.bbroot.com Zhajinhua service"
        },
        "technical_plan": "5b2a2fc8c6a5557cf0c023e1a50ceabb041e8d8f465a58c56246d6c054419636"
      },
      "artifacts": [],
      "batch": {
        "frozen_at": "2026-08-19T04:42:02Z",
        "task_ids": [
          "be50d92f-59cc-4b99-8286-31b29374c38b",
          "e842278c-e053-45be-aa35-a144f49b57ab",
          "71d4428f-ff22-4e8d-bdb8-f09efcb0221b"
        ]
      },
      "confirmation_gate": {
        "reasons": [],
        "required": false
      },
      "created_at": "2026-08-19T04:36:26Z",
      "display_seq": "0000",
      "intent_hash": "4cf4d13a72fa667c0adaf75c753a3c76a15fc916b275ac98cd6d76a1ed5186ce",
      "kind": "code",
      "level": "L4",
      "pending_gate": null,
      "phase": "implementing",
      "residual_risk": [],
      "result_ref": null,
      "review": [],
      "route": null,
      "task_id": "be50d92f-59cc-4b99-8286-31b29374c38b",
      "title": "炸金花牌局体验闭环开发测试提交部署",
      "updated_at": "2026-08-19T04:42:02Z",
      "validation": []
    },
    "e842278c-e053-45be-aa35-a144f49b57ab": {
      "display_seq": "0001",
      "kind": "test",
      "level": "L3",
      "phase": "intake",
      "state_ref": "work-flow/docs/requirements/0001_炸金花接口黑白盒与浏览器验收_L3/task-state.md",
      "state_sha256": "753f9bfff2ac75e326664b24cee7e0eb5bc7dd4ae8f1db1c46b836adca7ddf8f",
      "task_id": "e842278c-e053-45be-aa35-a144f49b57ab",
      "title": "炸金花接口黑白盒与浏览器验收",
      "updated_at": "2026-08-19T04:41:39Z"
    }
  },
  "template_version": "1.0.0",
  "workspace_id": "ws-fd23a02ea0f2db963627743a"
}
---end-workflow-state-json---

人类可读投影由 runtime 维护；JSON 哨兵块和引用哈希是机器权威。

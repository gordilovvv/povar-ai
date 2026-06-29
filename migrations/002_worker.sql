alter table wa_chats add column worker_state text; -- null | processing

drop table if exists webhook_tasks;

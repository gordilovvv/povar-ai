// import { pool } from './db/db.ts';
import type { WaMessage } from './platforms/whatsapp/parse.ts';

// центр входящего: на один чат собрать контекст и вызвать агента
export const handleChat = async (phone: string, messages: WaMessage[]) => {
    // 1. wa_message_id уже есть? → да: игнор (ретрай Meta)
    // 2. Получить текст, wa_id, referral (если есть)
    // 3. ФАКТЫ (код, не агент):
    // - inser guest
    // - inser chat || update last_received_at
    // - save входящее (owner=guest)
    // 4. Собрать контекст
    //  4.1  История чата (wa_messages по chat)
    //  4.2  Кто гость (guests)
    //  4.3  Вечеринки (party, без party_time и party_tables - агент потом получит через tools)
    //  4.4  Где гость в воронке (party_guestlist) ← вот это часто забывают
    //  4.5  Текущее время Дубай
    // 5. Вызвать агента
};

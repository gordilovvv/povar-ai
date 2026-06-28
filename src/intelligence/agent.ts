export const agent = new (class Agent {
    // - system prompt — кто он, тон, флоу (правила из CLAUDE.md/Figma)
    // - tools — список ручек (описание + zod-схема), которые отдаём Claude
    // - диспетчер tool-calls — по имени вызвать нужную функцию, вернуть результат
    // - сам loop — выше

    // agentic loop
    do() {
        // messages = собрать из контекста (история + факты)
        // loop:
        //     ответ = вызов Claude (messages + список tools)
        //     если Claude вернул текст без tool-calls → конец
        //     если Claude позвал tool(s):
        //         для каждого: выполнить ручку → получить результат
        //         добавить результаты в messages
        //         продолжить loop   ← Claude думает дальше с новыми данными
    }
})();

const titles = new Map<string, string>();

export async function saveTitle(chatId: string, title: string) {
  titles.set(chatId, title);
}

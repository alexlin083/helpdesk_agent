// 前端的部署版本資訊。版本控制中的這個檔案各欄都是 null，代表本機開發；
// deploy/web.Dockerfile 在建置 image 時會依 deploy/hd build 傳入的版本覆寫成實際值（tag、commit、branch）。
export const WEB_VERSION = Object.freeze({ tag: null, commit: null, branch: null });

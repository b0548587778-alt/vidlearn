// מפתחות השורש של בעל התוכנה — אותם מפתחות ציבוריים שב-SuperSuite (shell/licensing/root-keys.js שם).
// VidLearn מקבלת רישיונות שהונפקו במסך "רישוי ומערכות" של SuperSuite (מרכז הרישוי לכל התוכנות של הבעלים).
// כאן נמצא רק המפתח הציבורי: הוא אינו סוד, ואי אפשר להנפיק איתו רישיונות.
// יותר ממפתח אחד מאפשר להחליף מפתח בלי לפסול רישיונות קיימים. רשימה ריקה = בלי רישוי (האפליקציה פתוחה).
export const ROOT_KEYS = [
  'dytb6joLdUfUbhYcobHswxX2_Ss8CR7jbLq7uhd1SyI', // FOsKhK_x-Heqz5HZA2V1bQ
];

export const PRODUCT = 'vidlearn'; // מזהה התוכנה בקטלוג המוצרים של מרכז הרישוי (products.js שם) — לא לשנות
export const FEATURE = 'vidlearn'; // שם התחום ברישיון שפותח את האפליקציה
export const TRIAL_DAYS = 30;      // תקופת ניסיון מלאה מההפעלה הראשונה; אחריה — רק מסך הרישיון וההגדרות

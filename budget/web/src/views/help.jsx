// The (i) pop-up texts, all in one place. <Help k="..." /> (Info.jsx) shows one.
// Keep each short: what it is, how it's worked out, and what to do about it.

export const HELP = {
  rta: { title: 'Ready to assign', body: <>
    <p>Money that has come in but hasn't been given a job yet. Give every dollar a job by assigning it to categories until this reaches <b>$0</b>.</p>
    <p><b>Green</b> means money still waiting. <b>Red</b> means you've assigned more than you have: lower an assigned amount somewhere.</p>
    <p>Tap the amount for the <b>bank check</b> (does the money in your budget match your accounts?) and to <b>hold</b> money for next month.</p>
  </> },

  categories: { title: 'Assigned, spent and available', body: <>
    <p><b>Assigned</b> is what you've set aside in a category this month.</p>
    <p><b>Spent</b> is what you've spent from it this month (refunds count back).</p>
    <p><b>Available</b> is what's left to spend: everything assigned, less everything spent, including leftovers from earlier months.</p>
    <p>A <b>red</b> amount means the category is overspent: move money in from another category, or from Ready to assign. A <b>target</b> (tap a category) fills a bar as you fund it, and <i>Needs</i> lists the ones still short.</p>
  </> },

  moneycheck: { title: 'Money check', body: <>
    <p>A quick health check of this month. When everything's fine it says <b>All accounted for</b>. Otherwise it lists what needs a look:</p>
    <p><b>Overspent</b> categories (cover them from another category), <b>uncategorized</b> transactions, card spending that isn't covered yet, possible <b>duplicates</b>, and money that isn't accounted for. Tips your bank still hasn't posted after 10 days are listed too, as a reminder.</p>
    <p>Tap the card to open it, and tap an item to fix it.</p>
  </> },

  needs: { title: 'Below target', body: <>
    <p>Categories with a target that isn't fully funded this month, and how much each still needs.</p>
    <p>Tap <b>Fund</b> to move that amount from Ready to assign, or tap the category to change or remove its target.</p>
    <p>Money you funded and then spent still counts as funded, so a category isn't listed again just because you used it. Your card payoff category is never listed: it's paid down, not filled.</p>
  </> },

  overplan: { title: 'Over plan', body: <>
    <p>Categories where you've <b>spent more than the monthly target</b> this month, even if you've already covered it.</p>
    <p>It's a nudge to check whether the plan is right: a subscription that went up, or groceries that cost more than they used to. Categories without a target aren't checked.</p>
    <p>It also lists <b>scheduled bills</b> whose latest real charge was higher than scheduled. <b>Update</b> raises the scheduled amount and the target to match.</p>
  </> },

  bankcheck: { title: 'Bank check', body: <>
    <p>Does the money in your budget match the money in your accounts?</p>
    <p>It adds up <b>Ready to assign</b>, everything still <b>in categories</b> (only what's left, so overspending doesn't lower it), money assigned to future months, and money set aside to pay cards. That should equal the balance of your budget accounts.</p>
    <p>If they don't match, a transaction is probably missing or entered twice: reconcile your accounts against the bank.</p>
    <p><b>Debts</b> are listed separately, so you can check that what you owe matches your statements.</p>
  </> },

  aom: { title: 'Age of money', body: <>
    <p>How many days, on average, your money sat in your accounts before you spent it. It looks at your last 10 purchases, with the oldest money spent first.</p>
    <p><b>Higher is better.</b> Around 30 days means you're spending last month's income, not living paycheck to paycheck. It needs a little history before it shows a number.</p>
  </> },

  networth: { title: 'Net worth', body: <>
    <p>Everything you have (bank, cash and savings accounts) minus everything you owe (cards and loans).</p>
    <p>Off-budget accounts, like a mortgage or an investment, count too. Keep their balances up to date for a true picture.</p>
  </> },

  readytopay: { title: 'Ready to pay', body: <>
    <p>How much of your card balances is already covered by money in your budget.</p>
    <p>When you buy something with a card, the money comes out of that purchase's category and is set aside for the card. Paying this amount to the card keeps you from carrying debt.</p>
    <p>If it's less than the balance, part of the card is older debt or uncovered spending.</p>
  </> },

  wherewent: { title: 'Where it went', body: <>
    <p>Your spending by category (or group) for the period you pick.</p>
    <p>It counts money spent from categories, less refunds. Card payments and transfers aren't spending, so they're left out. Your card payoff category only counts money actually spent from it.</p>
    <p>Tap a slice, or a row, to see its transactions and edit one.</p>
    <p><b>🎯 Categories</b> picks which categories the chart shows, for example to leave out a big debt payment while you work through it. <b>Hide from chart</b> in a slice's pop-up does the same for one slice. Hidden spending is listed under the chart, and percentages are of what's shown.</p>
  </> },

  aomtrend: { title: 'Age of money over time', body: <>
    <p>How your age of money (how long money sits before it's spent) has moved over the last 6 months. A rising line means you're getting further ahead of your bills.</p>
  </> },

  networthtrend: { title: 'Net worth over time', body: <>
    <p>What you have minus what you owe, at the end of each month. Starting balances count from the month you added each account.</p>
    <p>Use <b>Accounts</b> above to choose which accounts are included.</p>
  </> },

  forecast: { title: 'Forecast', body: <>
    <p>Each account's balance day by day for the next weeks, worked out from your <b>scheduled</b> transactions (paycheck, bills) and anything entered with a future date.</p>
    <p>It warns when an account would dip <b>below zero</b> before payday, so you can move money or a bill in time.</p>
    <p>Payday comes from <b>When do you get paid</b> at the top, or else from a scheduled paycheck.</p>
    <p>Spending you haven't scheduled isn't included, so leave some room.</p>
  </> },

  payday: { title: 'Payday', body: <>
    <p>Tell Once Budget <b>when</b> you get paid: weekly, every 2 weeks, twice a month or monthly, and one payday to count from. No amount is needed, because paychecks change.</p>
    <p>The forecast then checks that each account lasts <b>until your next payday</b>, and marks paydays on the list and the calendar.</p>
    <p>A payday on a weekend usually arrives the <b>Friday before</b>; pick what your bank does. Holidays aren't moved, so allow a day around them.</p>
    <p>Two people paid on different schedules? Add another paycheck. A scheduled paycheck with an amount still counts in the balances.</p>
  </> },

  scheduled: { title: 'Scheduled', body: <>
    <p>Transactions that repeat: paycheck, rent, bills, subscriptions, loan payments.</p>
    <p>When one is due it shows under <b>Due</b> on the Budget screen: <b>Post</b> it (change the amount first if the bill was different) or <b>Skip</b> it. Ones set to <b>post automatically</b> are added for you on the day.</p>
    <p>They also feed the <b>forecast</b> and the payday check.</p>
    <p>Tap one to change its amount, date or how often it repeats.</p>
  </> },

  server: { title: 'Your own server', body: <>
    <p>Optional. Without a server, your budget lives only on this phone. With one, which you run yourself at home, every phone and browser shares the same budget and changes sync both ways.</p>
    <p>The <b>home address</b> is used on your Wi-Fi, and the <b>away address</b> everywhere else (for example a Tailscale address). Changes made offline sync when you're back.</p>
    <p>Easiest setup: on the server's <b>Pair a phone</b> page, scan the QR code with your camera, or tap <b>Pair with a code</b>.</p>
  </> },

  sharing: { title: 'Who can open this budget', body: <>
    <p>Each budget on your server belongs to the people listed here. Nobody else using the server can see it, or even that it exists.</p>
    <p>Each person has a level, which an owner picks when sharing and can change any time:</p>
    <p><b>Owner</b>: everything, including sharing, renaming, erasing and restoring it. <b>Change everything</b>: accounts, categories, money, schedules and rules. <b>Add purchases</b>: adds purchases (typed, tap-to-pay, tips) and changes or deletes the ones they added; they can't assign or move money or edit anything else. <b>View only</b>: sees everything, changes nothing.</p>
    <p>Your server checks every change, so a level can't be got around. Someone with a limited level sees a note at the top saying what they can do.</p>
    <p>How people are told apart depends on how your server signs people in. With <b>Cloudflare</b> you share by email. With a <b>server password</b> (home network), the admin adds each person on the server's Pair a phone page and gives them a code. In <b>open</b> or <b>local</b> mode everyone shares every budget.</p>
    <p>Whoever runs the server can still read its files and backups, so share a server only with people who trust its owner.</p>
  </> },

  backups: { title: 'Automatic backups', body: <>
    <p>The app saves a copy of your budget on this phone every day and keeps the most recent ones. <b>Restore</b> brings one back if something goes wrong.</p>
    <p>Copies on the phone are lost if the app is uninstalled, so also copy them to a folder (for example one your cloud app syncs) or export now and then.</p>
  </> },

  taptopay: { title: 'Tap-to-pay capture', body: <>
    <p>When you pay with Google Wallet, Wallet shows a notification. The app reads only that one (store, amount, card) and offers to log the purchase, so you don't have to type it.</p>
    <p>Nothing leaves your phone, and every other notification is ignored. Missed purchases wait in a banner at the top of the app.</p>
  </> },

  cardroll: { title: 'Credit card overspending', body: <>
    <p>What happens when card spending is more than the category had.</p>
    <p>During the month it stays red in the category. Cover it then and the money is set aside for the card you used. Or leave it: the category's Cover sheet lets you cover only the cash part.</p>
    <p>With this on, at the end of the month what's left moves into your <b>payoff category</b> as debt to pay down, instead of staying red in the category. That keeps next month clean and shows plainly what you owe.</p>
    <p>The payoff category shows the card debt it still holds. Paying a card first uses its Ready to pay (money its purchases' categories set aside); anything more pays this debt down, and comes out of Ready to Assign by itself. You don't assign money to record a payment.</p>
    <p>Money you do assign to the payoff category is set aside for your next payment, and goes to the cards in your <b>debt plan's order</b>: each card's minimum first, then the next card by snowball or avalanche. Switch that off and each card gets back what was rolled from it.</p>
  </> },

  closemonths: { title: 'Close months', body: <>
    <p>Locks finished months: no new or edited transactions dated in them, and no assignment changes. That keeps reconciled history from changing by accident.</p>
    <p>Close a month after you've reconciled it. You can reopen it here if needed.</p>
  </> },

  streaks: { title: 'Streaks', body: <>
    <p><b>🔥 Logging:</b> days in a row with at least one transaction entered.</p>
    <p><b>🛡️ On budget:</b> finished months in a row with no overspent category.</p>
    <p><b>🌿 No-spend:</b> days this month without a purchase.</p>
    <p>They're worked out from your budget, so every device shows the same.</p>
  </> },

  tips: { title: 'Tips', body: <>
    <p>When you pay with a card, the bank first shows the amount <b>before the tip</b>. The restaurant sends the final amount later, sometimes a week later, and then the bank's amount goes up.</p>
    <p>Type the amount on the receipt (what the bank shows now), then pick a tip. Your budget counts the <b>full amount</b> straight away, because that money is spent.</p>
    <p>Until the bank catches up, the purchase shows <b>+ tip waiting</b> under its amount, and the account says what your bank shows for now, so a difference never looks like a mistake.</p>
    <p>When the bank shows the final amount, tap the circle on the purchase in the account. If the bank posted a different amount, type it and the purchase and its category update. Tips still waiting after 10 days show in Money check.</p>
  </> },

  debtorder: { title: 'Snowball, avalanche and extra', body: <>
    <p>Every month the plan pays the <b>minimum on every debt</b>. The order decides where the money above the minimums goes.</p>
    <p><b>Snowball:</b> smallest balance first. You clear whole debts sooner, which keeps you motivated.</p>
    <p><b>Avalanche:</b> highest interest rate first. You pay the least interest overall.</p>
    <p><b>Extra per month</b> is money on top of the minimums. It all goes to the first debt in the order. When that debt is paid off, its minimum and the extra roll onto the next one, so each payoff speeds up the next.</p>
    <p><b>When nothing changes:</b> if your smallest debt also has the highest rate, both orders pick the same debts in the same order, so the plan is identical. The order matters only when a bigger debt has a higher rate than a smaller one.</p>
  </> },

  debtlist: { title: 'Payoff order', body: <>
    <p>The numbers show the order debts get paid off. The green number gets the extra money now; the others get their minimum until it's their turn.</p>
    <p><b>Interest rate and minimum</b> come from your statement. Until you enter them, cards are assumed at 21% and loans at 6%, with a typical minimum, and the debt shows ⚠ estimated.</p>
    <p><b>Paid off</b> is the month that debt reaches $0 with these payments. <b>This month pay</b> is what to send it this month.</p>
    <p><b>Leave out of plan</b> takes a debt out of the debt-free date and the payments, for example one someone else pays. You can add it back at the bottom.</p>
  </> },
};

# Scheme Performance & Impact Calculator and Planner

### User Guide

Version 1.0 · For review · 16-11-2026

## Document control

| Item | Value |
| --- | --- |
| Document | Scheme Performance & Impact Calculator and Planner: User Guide |
| Version | 1.0 |
| Date | 16-11-2026 |
| Prepared by | Engineering team |
| Status | For review |
| Client | Acme Paints |
| Audience | Business users of the app: scheme managers, sales and finance teams, viewers and administrators |
| Note | Sanitised public copy: screenshots are omitted because they showed client data; scheme names are made up |
| Related documents (in the repo) | docs/technical-solution-document.md (how the app is built), docs/logic.md (formulas with examples) |

## Index

| Section | Page |
| --- | ---: |
| [1. About this guide](#1-about-this-guide) | 4 |
| [2. Words used in this guide](#2-words-used-in-this-guide) | 4 |
| [3. Getting started](#3-getting-started) | 5 |
| [4. The screen at a glance](#4-the-screen-at-a-glance) | 7 |
| [5. Choosing what you see](#5-choosing-what-you-see) | 8 |
| [6. Overview tab](#6-overview-tab) | 9 |
| [7. Plan tab](#7-plan-tab) | 10 |
| [8. Simulator tab, reading the month table](#8-simulator-tab-reading-the-month-table) | 11 |
| [9. Simulator tab, changing figures](#9-simulator-tab-changing-figures) | 15 |
| [10. Simulator tab, changing slabs and rates](#10-simulator-tab-changing-slabs-and-rates) | 16 |
| [11. Planning next month](#11-planning-next-month) | 18 |
| [12. Checking and undoing your edits](#12-checking-and-undoing-your-edits) | 19 |
| [13. Scheme detail](#13-scheme-detail) | 20 |
| [14. Dealer lists](#14-dealer-lists) | 22 |
| [15. Gift schemes](#15-gift-schemes) | 23 |
| [16. Saving and managing versions](#16-saving-and-managing-versions) | 24 |
| [17. Exporting to Excel](#17-exporting-to-excel) | 26 |
| [18. Light and dark display](#18-light-and-dark-display) | 26 |
| [19. Good to know](#19-good-to-know) | 27 |
| [20. Questions and answers](#20-questions-and-answers) | 28 |
| [Assumptions](#assumptions) | 28 |


---

## 1. About this guide

The Scheme Performance & Impact Calculator and Planner shows how much Acme Paints pays its dealers in **credit
notes** under each rebate scheme, and lets you try changes before they are made. You can change a sales figure, a
rate or a slab boundary and see at once what it does to the credit note, for all India or for any zone, region or
depot.

This guide walks through every screen in the order you are likely to use them. Each section says what the screen
is for, then gives the steps.

> Screenshots are omitted from this public copy because they showed client data.

---

## 2. Words used in this guide

| Word | What it means |
| --- | --- |
| Credit note (CN) | The rebate a dealer earns under a scheme, paid as a credit against future purchases. |
| GSR | Gross sales in rupees, after the invoice (in bill) discount. Most rates are a percentage of GSR. |
| Scheme | A rebate offer, for example Premium or Luxury. A scheme can have several parts, called components. |
| Slab | A band of sales inside a scheme, for example 40 to 100 litres. Each slab pays its own rate. A dealer earns the rate of the slab their sales reach. |
| Slab boundary | The figure where one slab ends and the next begins. |
| Rate | What a slab pays: a percentage of GSR, or rupees per litre or per pack. |
| Product | A group of schemes that sell the same range, for example Luxury or Waterproofing. |
| Product mix | One product's share of total volume. |
| CN % of GSR | Credit note divided by GSR: how much of the sales value goes back to dealers. |
| Impact | Simulated CN minus actual CN: what your change would cost (a plus) or save (a minus). |
| Part month | A month still in progress. The app shows "day 6 of 30" when the file covers six days. |
| Version | A set of edits you saved so you and others can open it again. |
| Cr, L, kL | Crore and lakh of rupees; kL is a thousand litres. "L" always means lakh, never litres. |
| pp | Percentage points: the change between two percentages, for example 7.2% to 7.7% is +0.5 pp. |

---

## 3. Getting started

### 3.1 Sign in

1. Open the address your administrator gave you in a current web browser such as Chrome or Edge.
2. Type your **Username** and **Password**.
3. Press **Log in** (or Enter).


After five wrong passwords from the same computer within 15 minutes, the app stops accepting tries for a while.
Wait and try again, or ask your administrator to reset your password.

> The first time the app starts on a server it needs about a minute to read the month's data. Until then figures
> show as "—" and the app retries by itself every few seconds. This is normal.

### 3.2 Sign out and sessions

- Press **Log out** at the top right to end your session.
- A session lasts 8 hours. If it ends while you are working, a sign in box opens over the page. Sign in again and
  your unsaved edits are still there.
- Closing the browser tab while you have edits asks you first, so you do not lose work by accident.

### 3.3 What you can do depends on your role

| Role | What it can do |
| --- | --- |
| Viewer | Sees every tab and every figure. Cannot edit, cannot open dealer lists, cannot save versions. |
| Scheme manager | Everything a viewer can do, plus: opens dealer lists, and edits only the schemes assigned to them (slab tables, rates, a scheme's volume, GSR and CN, a gift scheme's rule). Saves, archives and deletes only their own versions. |
| Administrator | Everything, including product and total edits, next month's volume change and deleting schemes from a simulation. |

The app shows edit boxes only where your role allows. If you ever see a message that an edit is not allowed, your
role does not cover that scheme or that kind of change; ask your administrator.

---

## 4. The screen at a glance

The bar at the top stays the same on every tab.


| Part of the bar | What it tells you or does |
| --- | --- |
| Title line | What you are looking at: "All India" (or your filter), the number of schemes and dealers. |
| "data as of 6 Nov 2026" | The date of the data file the figures come from. |
| "part month · day 6 of 30" | Shown while the month is not over. A part month is not a small month: dealers cross slabs as the month goes on. |
| Tabs | **Overview**, **Plan**, **Simulator** and **Versions**. A number on Simulator counts your edits. |
| Your name and **Log out** | Who is signed in. |
| Moon or sun button | Switches between light and dark display. |
| **Export to Excel** | Downloads what you see as a workbook. |
| Filters | **Zone**, **Region**, **Depot**, **Find scheme** and **Verified only**. |
| Readout | Volume, GSR, Credit note and CN % of GSR for what is selected, with the change against the previous month. After an edit it also shows **Simulated CN** and **Impact**. |

Colours used across the app:

- Volume, GSR and mix: **green** when higher, **red** when lower.
- Credit note and CN %: **red** when higher (it costs more), **blue** when lower. Lower CN is never shown in green,
  because a lower simulated CN is the cost of a future structure, not money recovered.

---

## 5. Choosing what you see

Every tab follows the filters at the top.

1. Click **Zone**, **Region** or **Depot**. A list opens.
2. Tick one or more values. **Select all** and **Clear** are at the bottom of the list.
3. Press **Done**. The page updates when the list closes.


- The **Region** list shows only the regions of the zones you picked, and **Depot** only their depots.
- **Find scheme** narrows the tables to schemes whose name contains what you type, for example "Luxury".
- **Verified only** hides schemes whose calculated payout does not yet match the data file. Schemes that match
  carry a green **Verified** tag.
- **Clear filters** (appears once a filter is on) goes back to All India.
- Filters are kept in the address bar, so a page reload or a shared link keeps them.

---

## 6. Overview tab

The Overview answers two questions: where does the money go, and which schemes are expensive for what they sell.

**Where the payout goes** lists the ten schemes that pay the most, with the rest grouped as "Other". The bar is the
scheme's share of the total credit note. The dot on the right is what the scheme pays as a percentage of its own
GSR; the line marks the business average.


To see one scheme by slab:

1. Click the scheme's row, for example **Premium**.
2. A **Breakdown** opens at the bottom of the page. It shows every component of the scheme, each slab's rate, its
   credit note and how many dealers are in it.
3. Press **Edit slabs** to open that scheme in the Simulator, or the cross to close the breakdown.


**What each scheme pays, as % of its own GSR** lists every scheme, highest first. Orange bars pay above the
business average, blue bars below it. Click any scheme to open its breakdown.


Press **Show all schemes** under the first chart to list all of them instead of the top ten.

---

## 7. Plan tab

The Plan tab looks back at finished months and forward to the month in progress and the next one.

**Month cards** at the top show each finished month's payout, dealers and GSR. A month that only holds a mid month
snapshot is marked "excluded", because it would understate the month.

**Month in progress** projects the current month to its close.


- The three bars compare how far the month has gone (calendar), how far sales have got (GSR) and how far payout has
  got (CN), each against all of last month.
- Payout runs behind sales early in the month because dealers earn nothing until they cross a slab. That is why
  simply scaling today's payout by the days gone understates the month.
- The three boxes show three ways to project. The one marked **USED** is the figure shown as the projected payout.
  It is a simple projection, not a forecast model.

**Plan next month** answers "what would a sales growth of X% cost in credit notes".

1. Type a growth figure in the box, drag the slider, or press **flat**, **+5%**, **+10%**, **+15%** or **+20%**.
2. Read the result: projected credit note, payout rate, **elasticity** (how much CN grows for each 1% of sales) and
   how many dealers move up into a higher slab.
3. To try a different growth for one scheme, type it in that scheme's **Growth** box in the table below.


Growth is applied to each dealer, then each dealer is placed in the slab they would reach. Payout therefore grows
faster than sales. Schemes that pay a flat amount per dealer do not grow with sales.

Further down, **What moved between** two months lists the change in credit note by scheme, and **Forecasting** says
what more history the app would need for a true seasonal forecast.

---

## 8. Simulator tab, reading the month table

The Simulator is where you try changes. It shows one table with three months side by side.


| Column group | What it is | Can you edit it? |
| --- | --- | --- |
| **Previous** | The last finished month, as settled. | No, read only. |
| **Current** | The live month from the latest data file. | Yes. Your edits change this month (and next month follows). |
| **Next** | A plan for next month: the current month, with your edits, grown by **V** (the volume change you type). | Yes. Edits here change next month only. |

Each column group shows Dealers, Volume, Product mix, GSR, CN % of GSR and CN. Under a figure, a small coloured tag
shows its change against the month before, when the change is large enough to matter (1% or more, or 0.1 pp for
shares). The **Total** row sits at the bottom.

### 8.1 Help on the page

Press **How to read** above the table for a short explanation of every figure and every kind of edit. Press
**Close** to hide it.


The toolbar also has:

- **Overall Schemes** and **Scheme detail**: two views of the same data (see section 13).
- **Sort schemes**: largest payout, biggest impact, or name.
- **Edited only**: shows only rows you changed.
- **Save version**, **Collapse all** and **Reset all** (sections 12 and 16).

### 8.2 Open a product, a scheme and its slabs

1. Click a product name, for example **Luxury**. Its schemes open underneath.
2. Click the small arrow in front of a scheme to open its **slab tables** inside the month columns. Each month shows
   its own slab table, so the rows of the three months do not line up on purpose.
3. Click a scheme's **name** instead to open it in Scheme detail (section 13).
4. Press **Collapse all** to close everything again.



How to read a slab row:

- "40 to 100" is the range of the slab, in litres or rupees as the scheme decides. Ranges never start below 0.
- "12 regions" or "Kerala" shows which regions' rate cards that row covers. Regions can pay different rates for the
  same slab, so one slab can appear on more than one row ("same slab").
- The dealer count is a link that opens the list of those dealers (section 14).
- Value and Early Bird pay on a dealer's whole book, so they show only CN, no volume or GSR.
- An add on scheme (for example a per pack offer) shows its volume and GSR greyed out, because those sales are
  already counted in the main scheme.

---

## 9. Simulator tab, changing figures

### 9.1 Type a new figure

Any figure in the **Current** or **Next** column that you are allowed to edit becomes a box when you click it.

1. Click the figure, for example the GSR of **Premium** in Current.
2. Type the new value. You type the figure itself, not a percentage; the app works out the change.
3. Press **Enter** to apply, or **Escape** to cancel.


Where you click decides what moves:

| You change | What happens |
| --- | --- |
| The **Total** row's Volume or GSR | Every product moves in proportion. |
| The Total row's **CN** | Every rate in the book is scaled to reach the figure. |
| A **product's** Volume or GSR | Only that product moves; the total changes with it. |
| A product's GSR with the switch set to **price** instead of **more sales** | Same litres at a new price: GSR and rupee based payouts move, litre based slabs stay. |
| A product's **Product mix** with **total held** | Sales move between products; total GSR stays the same. |
| A product's Product mix with **volume grows** | Only that product sells more until it reaches the share. |
| A product's **CN %** or **CN** | That product's rates are scaled to reach the figure. |
| A **scheme's** Volume or GSR | Only that scheme's sales move. |
| A scheme's **CN** | That scheme's rates are scaled to reach the figure. |

When a sales figure moves, each dealer's sales move with it, and dealers who cross a slab boundary change slab.
A dealer keeps the rate of the month they actually earned unless you change the rate or the boundary itself.

An edit applies to the filters you typed it under. An edit made with Zone South selected covers South only, and it
still shows when you go back to All India.

### 9.2 See the effect

After an edit:

- The edited figure is highlighted, and the row shows an **edited** tag with **Reset** to undo that scheme.
- An **Impact** column appears next to the product names with the change for the current and next month.
- The readout at the top shows **Actual CN**, **Simulated CN** and **Impact** for everything selected.
- A note reminds you that volumes are held fixed and that a lower CN is not money recovered.


---

## 10. Simulator tab, changing slabs and rates

Open a scheme's slab tables first (section 8.2). Slab edits in the **Current** column change the current month, and
next month follows. Slab edits in the **Next** column change next month only.

### 10.1 Change a rate

1. In the Current slab table, click the slab's **Rate**.
2. Type the new rate, for example 1 for 1%, and press **Enter**.
3. The row shows the new rate with "was 0.75%" under it, the new CN and the impact in rupees.

You can also click a slab's **CN** or **CN %** and type the payout you want; the app works out the rate for you.


### 10.2 Move, add or remove a slab boundary

1. Click the end figure of a slab, for example the 46 in "40 to 46".
2. Type the new end and press **Enter**. Dealers are placed again into the slabs they now reach, and a tag above
   the table says the boundaries were moved.
3. Press **+** next to a slab to split it in two, then type where the split should be.
4. Press **×** next to a slab to remove it. Its dealers drop to the slab below and are paid that slab's rate. The
   first slab has no slab below, so removing it pays its dealers nothing.

If a figure cannot work, the app says why under the box and does not apply it. For example, a slab cannot end above
the start of the slab after it.


Good to know:

- Each dealer keeps their own region's rate card. A dealer who stays in their slab keeps exactly their rate; one
  who moves into a new slab gets the rate most of their region earns there.
- Slab and rate edits stay when you change the filters. A rate edit then applies to the dealers in that slab who
  earned that old rate, and a message tells you so.
- Schemes with a target per dealer start as one band; press **+** to give them boundaries.

### 10.3 Delete a scheme from the simulation

An administrator can press **Delete** next to a scheme's name. The scheme then pays nothing in the current and next
month; its volume and GSR stay. A **Restore** button above the table brings it back. Nothing is deleted from the
data: this only shows what the book would cost without that scheme.

---

## 11. Planning next month

The **Next** column is next month's plan. It starts from the current month as shown, with your edits.

1. In the Next column's header, type a figure in the **V** box, for example 10 for 10% more volume, and press
   **Enter**. Every dealer's sales grow by that much, and dealers who cross a boundary move slab.
2. To change next month only, click a figure or a slab in the Next column and edit it the same way as in Current.
   The first slab edit in Next gives that scheme its own next month table; **Use current month's** drops it again.
3. The **Impact** column then shows the cost for both months.


To set V back to 0, clear the box or use the small reset button next to it. Impact in Next is measured against next
month with the same volumes and the published slab tables.

The Plan tab (section 7) also answers "what does X% growth cost", but it re rates dealers who cross a slab, while the
Simulator keeps each dealer's actual rate. The two can therefore differ a little at the same growth. Both are
intended.

---

## 12. Checking and undoing your edits

- Press **Edits (n)** in the toolbar to list every edit you made, each with its own **×** to undo it.
- Press **Edited only** to show only the rows you changed.
- Press **Reset** on a scheme row to undo that scheme's edits.
- Press **Reset all** to undo everything. The app asks first, and after it resets you can press **Undo** for 10
  seconds.



Your edits live only in your own browser. Nobody else sees them unless you save a version (section 16). They are
lost when you close the browser, so save a version if you want to keep them.

---

## 13. Scheme detail

Scheme detail shows one scheme at a time with every slab table in full, and compares it with the month before.

To open it:

- Press **Scheme detail** above the table, or
- Click a scheme's name in the Overall Schemes table; that scheme opens and the page scrolls to it.


1. Choose the month with **Previous**, **Current** or **Next**.
2. Click a scheme to open it. Its summary shows Volume, Product mix, GSR, Dealers, Credit note and CN % of GSR.
3. Under each figure you see the same figure for the month before and the change, when it is large enough to
   matter. Here CN and CN % that went up are red and went down are green; volume, GSR, dealers and mix that went up
   are green.
4. Each component's slab table lists the current rate, the new rate, actual and simulated CN and the impact. A slab
   that did not exist the month before is tagged **new slab**; a changed rate shows "rate was ...".
5. Use **Compare with** to switch the comparison off or on. Your choice is remembered.
6. Edit rates, boundaries and figures here exactly as in the month table (sections 9 and 10).
7. Press **← Overall Schemes** to go back to the table where you were.


---

## 14. Dealer lists

Scheme managers and administrators can see which dealers are behind any count.

1. Click a dealer count (an underlined number) in any slab row, in any month.
2. A list opens with each dealer's code, name, region, depot, achievement, shortfall to the next slab, the next
   slab, how far they reached, GSR, rate and CN. After an edit it also shows the simulated CN.
3. Type a code or name in **Search dealers** to find one dealer. The list shows 50 dealers a page.
4. Press **Close** or Escape to close it.


The list always holds exactly the dealers counted in the row, including after you move a boundary. Dealer data is
client data: do not copy it outside the company. Viewers do not see dealer lists.

---

## 15. Gift schemes

Gift and contest schemes (Shine On, Glossa, Wallpaper and others) come from a separate gift file. They are
shown under the month table and are **never part of any CN figure**.


- **Dealers**: dealers in the scheme. **Qualified**: dealers who reached its first level.
- **Gifts**: the number of gifts earned. **Paid**: rupees, only for a rupee scheme such as 5% Nova Prime.

Click a gift scheme's name to open it in Scheme detail, with dealers grouped by gifts earned and by region.


Where a simple rule explains the file, for example one gift per 30 litres, you can click the rule or the volume and
try another figure; every dealer's gifts are worked out again. Schemes with tiers or one off thresholds are
**view only**. Gift what ifs stay in your browser and are not saved.

---

## 16. Saving and managing versions

### 16.1 Save a version

A version keeps your edits so you, or anyone else, can open them again later.

1. Make your edits in the Simulator. **Save version** then shows "unsaved".
2. Press **Save version**.
3. Type a **Name** (required, and unique) and a **Note** if you like.
4. Press **Save** (or Enter). Escape closes the box without saving.


A version keeps both months' edits, slab and rate edits, deleted schemes and V, together with the results at the
time of saving. Everyone who uses the app can see saved versions.

Rules:

- Each person keeps at most **10** versions that are not archived. Archive or delete one to save another.
- Names must be different from every other version, archived ones included (capitals and spaces at the ends are
  ignored).
- Versions saved before the live month and the two months before it are deleted automatically.

### 16.2 Open, compare and manage versions

1. Go to the **Versions** tab. Each version shows its edits, the actual CN, the version's CN and the change, for the
   current and next month.
2. Click a version's name to open it. You see its edits and an **Actual vs version** comparison by scheme, with the
   number of dealers who moved slab.
3. Switch between the current and next month with the month buttons, and choose under **Show** whether to see the
   result on the latest data file (**Live**) or as it was when saved.
4. Press **Open in Simulator** to load the version's edits and keep working. The save box then offers **Save
   changes** to update that version.
5. Press **Archive** to hide a version without losing it, and **Restore** to bring it back.
6. Press **Delete** to remove it for good. The app asks first and offers **Undo** for 10 seconds.


Each new daily data file recalculates open versions, so a version's live figures follow the latest data while its
saved snapshot stays as it was. You can change, archive or delete only your own versions, unless you are an
administrator.

---

## 17. Exporting to Excel

1. Set the filters and make any edits you want included.
2. Press **Export to Excel** at the top right.
3. The browser downloads a workbook named after the month.

The workbook has three sheets: **Summary** (month, data date, dealers, volume and GSR), **Schemes**, and **Slabs**
(scheme, component, applicable regions, slab, rate type, dealers, volume, GSR, current and new rate, actual and
simulated CN, impact, CN % of GSR and whether it was edited). Nothing you export is kept on the server.

---

## 18. Light and dark display

Press the moon button at the top right for dark display, and the sun button to go back. The app remembers your
choice on that computer.


On a phone or narrow window the filters stack and wide tables scroll sideways inside their box.

---

## 19. Good to know

- **Volumes are held fixed.** A rate or slab change assumes dealers sell the same amount. A higher rate may lift
  sales, so its true cost is likely higher than shown.
- **A lower CN is not money back.** The previous month's credit notes are already paid. A lower simulated CN is what
  a revised structure would cost in future.
- **A part month is not a small month.** Early in a month payout looks low because dealers have not crossed their
  slabs yet. Use the Plan tab's projection for the month's likely close.
- **Your edits are private** until you save a version. Two people editing at the same time never see each other's
  edits.
- **Errors are shown in plain words** in a banner with a **Retry** button. "Starting up or busy" means the server is
  loading data; wait a minute and retry.
- **Which data file?** The header and each month column show the file's date and version, for example "data as of
  3 Nov 2026 · v25". New files arrive daily, early afternoon India time, and the app picks them up by itself.

---

## 20. Questions and answers

| Question | Answer |
| --- | --- |
| Every figure shows "—". | The server is starting and reading the month's data. It retries by itself; wait about a minute. |
| I cannot click a figure to edit it. | Your role does not allow that edit, or the figure is in the Previous column, which is read only. |
| Why do I not see dealer lists? | Viewers cannot open dealer lists. Ask your administrator if you need them. |
| My edit disappeared after changing filters. | Figure edits apply to the filters they were typed under. Go back to those filters, or open **Edits** to see them all. |
| Save version says I already have 10. | Archive or delete one of your versions on the Versions tab, then save again. |
| Save version says the name is taken. | Pick another name; archived versions count too. |
| Plan and Simulator give different costs for the same growth. | The Plan tab re rates dealers who cross a slab; the Simulator keeps their actual rate. Both are intended. |
| A scheme has no Verified tag. | Its calculated payout does not yet match the data file. Treat its figures as provisional. |
| A gift scheme cannot be edited. | No simple rule reproduces its gift counts from the file, so it is view only. |
| I closed the tab and lost my edits. | Edits are kept only in the open page. Save a version to keep them. |

---

## Assumptions

- The guide describes the app as seen by an administrator, who sees every edit box. A scheme manager or viewer sees
  fewer.
- Screenshots are omitted from this public copy because they showed client data.

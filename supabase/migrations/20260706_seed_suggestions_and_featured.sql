-- Seed: current-events suggestions (source='seed') + featured "Discover" circles.
-- Complements the original curated suggestions; re-run safely after clearing source='seed'.

insert into public.suggestions (category, question, details, source, kind, metric) values
('💰 Crypto', 'Where does Bitcoin close this Friday?', 'Guess the BTC/USD price at Friday 4pm ET. Closest guess takes the pot.', 'seed', 'numeric', 'USD'),
('💰 Crypto', 'Will Bitcoin hit a new all-time high this month?', 'Resolves YES if BTC prints a new all-time high before month end.', 'seed', 'binary', null),
('💰 Crypto', 'Will Ethereum outperform Bitcoin this month?', 'Resolves YES if the ETH gain beats the BTC gain this calendar month.', 'seed', 'binary', null),
('🇺🇸 Politics', 'Will the Republicans win the 2028 presidential election?', 'Resolves YES if the GOP nominee wins the 2028 general election.', 'seed', 'binary', null),
('🇺🇸 Politics', 'Will the 2028 Democratic nominee be a sitting governor?', 'Resolves YES if the eventual nominee is a current state governor.', 'seed', 'binary', null),
('🏛️ Markets', 'Will the Fed cut rates at its next meeting?', 'Resolves YES if the FOMC lowers the target range at its next decision.', 'seed', 'binary', null),
('🏛️ Markets', 'Will the S&P 500 set a new all-time high this month?', 'Resolves YES if the index closes at a record before month end.', 'seed', 'binary', null),
('🏛️ Markets', 'Will the US enter a recession before 2027?', 'Resolves YES if the NBER dates a recession starting before Jan 1, 2027.', 'seed', 'binary', null),
('🏀 NBA', 'Will LeBron James play for a new team next season?', 'Resolves YES if he changes franchises before opening night.', 'seed', 'binary', null),
('🏀 NBA', 'Will a first-time franchise win the next NBA title?', 'Resolves YES if the champion has never won the title before.', 'seed', 'binary', null),
('🏈 NFL', 'Will an AFC team win the next Super Bowl?', 'Resolves YES if the AFC champion wins the game.', 'seed', 'binary', null),
('🐦 Internet', 'How many times will Elon Musk tweet this week?', 'Guess his post count Monday to Sunday. Closest guess wins.', 'seed', 'numeric', 'posts'),
('🎬 Culture', 'Will the top-grossing movie this year clear 1 billion dollars worldwide?', 'Resolves YES if the number-one film passes 1B in global box office.', 'seed', 'binary', null),
('🤖 Tech', 'Will a new frontier AI model launch before September?', 'Resolves YES if a major lab ships a new flagship model before Sept 1.', 'seed', 'binary', null),
('🤖 Tech', 'Will a new company join the 3 trillion dollar club this year?', 'Resolves YES if another public company closes above a 3T market cap.', 'seed', 'binary', null),
('🌡️ Weather', 'What will Saturday high temperature be in New York City?', 'Guess the official Central Park high in Fahrenheit. Closest guess wins.', 'seed', 'numeric', '°F'),
('🚀 Space', 'Will SpaceX fly Starship again this quarter?', 'Resolves YES if a Starship test launches before quarter end.', 'seed', 'binary', null),
('🎮 Gaming', 'Will the best-selling game this year be a sequel?', 'Resolves YES if the top seller is a numbered or sequel title.', 'seed', 'binary', null);

insert into public.featured_groups (name, emoji, blurb, member_count, sort_order) values
('Crypto Degens', '💸', 'Perps, memecoins, and questionable conviction.', 389, 1),
('NBA Twitter', '🏀', 'Hot takes, now with real stakes.', 271, 2),
('World Cup HQ', '⚽', 'The 2026 tournament, market by market.', 502, 3),
('Ivy League Locks', '🎓', 'Where the smart money argues.', 214, 4),
('Wall St. Bets IRL', '📈', 'Macro calls you can actually settle.', 176, 5),
('Sunday Sweats', '🏈', 'Every NFL Sunday, decided by Monday.', 198, 6),
('Awards Season', '🎬', 'Oscars, Emmys, and long-shot upsets.', 88, 7),
('Esports Arena', '🎮', 'LoL, CS, and Valorant majors.', 143, 8),
('NYC After Dark', '🌆', 'Bets on the city that never sleeps.', 156, 9),
('Vegas Lines', '🎲', 'Beat the sportsbook, together.', 233, 10);

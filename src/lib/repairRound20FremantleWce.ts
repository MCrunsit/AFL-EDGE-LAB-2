/**
 * One-off, hardcoded repair for a single data-linking gap: Round 20 2026,
 * Fremantle vs West Coast Eagles (match_id 4aeb3985-5d44-4102-bb91-e0b5dc53fef6).
 *
 * Root cause (diagnosed by hand against the live DB, not guessed): the 46
 * players' stats for this match were already imported into
 * player_game_stats, but with match_id/season/round left NULL — never
 * linked to the match. 44 of the 46 were also duplicated by two separate
 * import runs, verified byte-identical in every stat column (disposals,
 * marks, tackles, goals, hitouts, contested/uncontested possessions) — safe
 * to drop the duplicate copies without losing any data.
 *
 * This is intentionally NOT a general-purpose repair tool — every id below
 * was resolved and verified individually against the live database ahead of
 * time. It exists only so the fix can be triggered from inside the app
 * (Missing Stats Repair page) without needing separate Supabase dashboard
 * access. It does not touch player records, model formulas, or any other
 * match.
 */
import { supabase } from './supabase';

const MATCH_ID = '4aeb3985-5d44-4102-bb91-e0b5dc53fef6';

const KEEP_ROW_IDS = [
  '0df206ee-851d-4d96-8c90-a56163e8d014', '36b8cd52-d496-4131-8296-749b53e0aa52',
  'ce78ec93-8743-4fd1-8c56-5acb7a1bced2', 'dae0467c-5801-4383-9de3-961bb446b9ba',
  'aed264cb-44ad-4c4a-b589-bebd8b3a7ac3', 'e173f36d-71bd-41b4-9a99-79fb1fc67faf',
  '3b51feb7-9996-4ea1-9ebc-0f19a3af165c', 'f1adb32f-92a8-4201-b84a-92c7dc8e2f0b',
  '431097f6-1730-4531-a862-80aaf000f586', '6703aa69-564b-4854-b434-127849dde2a5',
  '0f89bc66-4fbc-4cdb-895a-4608ab5b6712', '366b0972-c8ac-43c9-882c-96417f9d9bea',
  'a40e8066-ad1a-407e-9d06-33d7b2cb6c01', '049415e1-e91d-4eeb-abfb-65c68c24620a',
  'eb164c88-b850-47e9-823b-5b8f485d880b', '870a604a-91d1-4e10-9532-afe8802c63b7',
  '974c56c3-58ac-4beb-ac3f-51ab89192e3b', '58283065-560f-4b34-8321-c1eba5d3a2ca',
  '559cc0c8-41ce-4ab3-8492-d47796513023', 'c8db639d-21da-4b9f-b599-8c7e736b0cd7',
  '32a316b7-f5ba-4168-8cd8-04fa4ac8a800', 'b7363969-f3dd-46eb-a28d-a0d689d403e9',
  '956171cf-f64f-4afa-86ce-50bb4e867842', 'f550b314-0ae5-4b5b-a62e-d18292a2a232',
  'fce8c2cc-d7f6-482d-9b8f-f29534efbd8e', '65f58140-15e2-4e65-801f-b056e2586a82',
  'ab55dfb1-f58b-406b-a41d-0783ea395982', '085f5cdb-5473-492a-9063-df0549ae62e8',
  'fcfd7f18-ea4e-46ff-8436-d9b2bee2230a', '65b959fa-4525-4b16-aa4d-659b2471511b',
  '8983ae18-62d6-4fb8-b4d2-da0b0a4dd681', 'c38e7f05-6f44-40ed-8dcc-ea64dd08d109',
  '3f4a8fb8-b39d-4f1b-bc9a-87119d824bbc', 'f307ba81-de25-44c0-9fb8-ebf935d5e520',
  '3fd32f5e-35df-4b0e-a24c-bc5f490a7dff', 'd3ea717f-e1b1-468a-8fd5-8db84ab7c162',
  '849b2a19-0a5a-4680-895d-eb9a9f74a094', '83c8650e-8e5b-4ef3-9af4-c82c392ec018',
  '063cd3f8-08c6-40f1-9905-ef1e1f5f1cc7', '6f88fb74-eaee-428b-8862-7f25d743b405',
  '9b31285d-e0bd-426d-b4f5-9dccdc0034b1', '4c917930-302b-4879-be43-35e1554080ac',
  '28d54caf-a4d6-459d-9b02-bae3b43f2ae6', '0a77b391-4257-4d99-b16f-5b67daa26337',
  'f739350b-715d-447b-8535-90ba4fa82d30', '5e0cc54e-f26f-4aa4-bb0a-bd7cb1b5b7bb',
];

const DUPLICATE_ROW_IDS = [
  'ae9afa6d-756d-428b-987e-f0fb121f75e8', '95817aae-7ca5-4b06-a196-c16a08584c23',
  '087dcd6d-7300-4823-aaf8-08385d57d18f', '665914a2-6e0d-452e-800e-cdde8611c3da',
  'a8b016c4-d2d0-4826-89bc-a6857a8edc77', '8707cbd9-e69b-4891-a191-f8da043ebc5a',
  '1d2eaa81-c50b-4465-bd98-e405a83d293c', '7fe534dc-2243-4249-b05f-1b0451f789eb',
  '62000c27-ac89-4252-9c11-5589bff9b5e8', '44da31cb-efdd-4b6d-8d77-530ec7ca0b24',
  'b3f6adff-bf15-40fb-b2a5-b246b7c797ea', 'b95f393a-edea-43a7-811f-03f811de2de8',
  'cc0ae0f3-090a-4a3c-898b-17ebc5227cf8', '66755465-0456-4461-bb32-bd155807a8cf',
  '60560bab-adc5-43b3-a83a-ca74d60acff0', 'c5496852-5818-4ece-a397-6a1ca29015f7',
  '292c6e1e-3ccc-412d-b5a8-68704eda067c', 'e463d7a7-f4fd-4d1d-88bb-7d6cedc92a3a',
  '72689af9-4618-45fd-a8c3-f0d6edde18bc', 'c05bfbe3-c073-43c0-abe2-15bf66e309a0',
  '739cfe6a-35be-4e26-989f-d3a735a9f450', '17455978-f115-4864-8672-6404d9c1ee52',
  '50d31cdc-4189-4114-8067-3b0e02e815da', 'bd8086ac-3e32-4ed4-ac04-bba13abbf4f4',
  'd9b29692-0cc9-4ada-949e-feac17692ced', '01daec11-a0ae-4ed6-9327-6d0cd5a255bc',
  'd61e8b44-01c1-4a0e-9680-2659be8ebd17', '822e37ec-15fe-4043-a73b-c02b2da0fa7d',
  '017992e7-8155-433c-a733-4c63d989fe9f', '7856022d-f826-4f85-a0f2-74aea6c8d559',
  '43c45aeb-7cb0-462a-b856-8dab2146cf0d', '38e71a13-e900-4081-88ed-3af853439601',
  '249fa153-0aba-4602-bcec-f921e25ef0bf', '35d4909e-c195-4867-866f-a81706d85191',
  'f9786274-3c9f-4fb2-8df3-74186b381d87', '07e69ab1-9ce3-4657-9b02-b4001324c8d5',
  'b8d06e8d-ab03-4dcb-a37d-704836c2d238', 'ff96d97f-b6dc-490a-8a17-f21655cbff2c',
  '1ea42a73-c36d-4d80-8877-c85b2d99fdb2', 'f5d69f25-cb0f-442c-90ba-82f1260b5a45',
  '1a9efbc3-5eaa-4412-8063-dfdc2ca9ab1f', '003bb29c-342a-4724-905c-66e464694baa',
  'e3b087cc-0389-473e-af41-4f440f88627c', '10b8a90f-212e-42bc-9447-27bb4b262ce7',
];

/** bookmaker_player_name -> resolved player_id, for this match's odds rows only. */
const BOOKMAKER_NAME_TO_PLAYER_ID: Record<string, string> = {
  'Alex Pearce': '004dbfc4-2d26-4fe0-bde0-00af716c0cc3',
  'Andrew Brayshaw': 'b6b01ff2-8c4a-4071-85ac-45371d9ba51b',
  // Bailey J. Williams -> the West Coast Bailey Williams. There are two
  // distinct real players named Bailey Williams (this one, west-coast, and
  // b7d57c1d-... at western-bulldogs) — never resolve this name by a plain
  // name match; this exact id was confirmed against the live players table.
  'Bailey J. Williams': 'b798bf88-0f7c-491f-82bc-3da6946a111c',
  'Bo Allan': '3b46c454-11d1-40bc-a92a-7fa5d2a3d77f',
  'Brady Hough': 'fde19a45-183f-401c-b26c-45cc1129a4ae',
  'Brandon Starcevich': '334fd76c-2259-4ac8-aa51-414cf4bd7906',
  'Caleb Serong': 'e8570882-f72a-468f-86e1-ce353ab3689a',
  'Corey Wagner': 'e52340b3-ac6c-44e8-b607-0195fc282b56',
  'Elliot Yeo': 'a5d4697f-e087-4f78-b31e-86e3d1d42eb0',
  'Hamish Davis': '2d927bb8-8da0-4919-afa7-1826e7da5e78',
  'Harley Reid': 'b60ad16d-4639-4b5d-b55f-f1c20912b656',
  'Harvey Johnston': 'd97b0422-afd6-4938-9ec3-971e1b2981eb',
  'Heath Chapman': '8fef651c-bd4e-4361-99e6-bb359b3d018f',
  'Isaiah Dudley': '04c0ee1e-9106-4e06-a1bb-43160131e656',
  'Jack Williams': '663ce8d1-bbc5-4ea5-905d-ead4dab44cbd',
  'Jake Waterman': 'ba5a6259-19bb-46dc-a7f0-f5c836e369db',
  'Jobe Shanahan': 'b8ec0c73-af1d-422d-b11c-9e2d0ec21302',
  'Jordan Clark': '5aba083b-dff3-49e2-addf-7614c4c54bc7',
  'Josh Treacy': 'cb9e9188-f32e-40ed-a73f-104989cc93ee',
  'Judd McVee': '435dfa0c-f398-43c2-8b83-0b5fc38cfae8',
  'Jye Amiss': 'b27f7306-817e-4d83-8da4-2f877ecf2b87',
  'Karl Worner': '323c4d67-b90c-4b8c-9d1b-567ab2a176fe',
  'Liam Duggan': 'ad4bf5f4-a2e0-4327-8726-2f1b6b4e454e',
  'Luke Jackson': '27e9721f-da8e-41b5-bf5a-5f1bd5993c45',
  'Luke Ryan': 'e8fea4f7-184d-43b1-8898-3b3df7495840',
  'Marcus Herbert': 'a22eb38c-76b1-4b4f-9f3b-216ff500be2f',
  'Mason Cox': '013e5afc-311f-4fbb-ac95-a3f7c5a450c2',
  'Matt Johnson': 'b907e7a5-5280-40a3-97ad-67178b92474a',
  'Michael Frederick': '09d7872d-8582-4848-9093-ff48aa61c279',
  'Milan Murdock': '84a6f004-ee82-420d-830c-220d8db49f13',
  'Murphy Reid': '7795ddf4-859f-4fa4-96f4-1512a815931c',
  "Nathan O'Driscoll": '32a0e4ae-7b34-4535-85cb-ebc2a65e0732',
  'Neil Erasmus': '82da3dff-1eba-42cd-b4b3-601c7825e8ce',
  'Oliver Francou': '5ed0bf69-0da0-4fe6-a742-7170c926f863',
  'Oscar McDonald': '45dccba1-eac0-4256-9c7a-017accc86217',
  'Patrick Voss': 'ff12e75f-1067-4793-8ad0-dbbba5015af4',
  'Rhett Bazzo': '4d2e03fc-8d41-44d6-9ac8-31e0a69e8f08',
  'Ryan Maric': '0569076b-9fa5-4b5e-9845-130497252b1b',
  'Sam Switkowski': 'cc5e6d1e-1745-4fb7-99a0-877340fb207c',
  'Sandy Brock': '6a4a651c-a420-4367-b006-4a3f3f9be2fd',
  'Shai Bolton': '86db0896-caa2-4566-9606-7df7b2934721',
  'Tim Kelly': '9da0dee1-cfc5-4473-8bfd-80a7652ba9bd',
  'Tom Cole': '407da344-a1ce-41b0-8527-fe1253f3f32b',
  'Tom McCarthy': '0a11b0f7-523c-4e05-a326-e64849ae446c',
  'Tylar Young': '77e646bc-2a2a-4a8d-bccd-dad45cd75fc7',
  'Willem Duursma': '45f33fc1-367e-4d73-9c2c-6bf11de812f5',
};

export interface Round20RepairResult {
  statsLinked: number;
  duplicatesDeleted: number;
  oddsRelinked: number;
  errors: string[];
}

export async function runRound20FremantleWceRepair(): Promise<Round20RepairResult> {
  const errors: string[] = [];
  let statsLinked = 0;
  let duplicatesDeleted = 0;
  let oddsRelinked = 0;

  const { data: linked, error: linkError } = await supabase
    .from('player_game_stats')
    .update({ match_id: MATCH_ID, season: 2026, round: '20' })
    .in('id', KEEP_ROW_IDS)
    .select('id');
  if (linkError) errors.push(`Linking stats rows: ${linkError.message}`);
  else statsLinked = linked?.length ?? 0;

  const { data: deleted, error: deleteError } = await supabase
    .from('player_game_stats')
    .delete()
    .in('id', DUPLICATE_ROW_IDS)
    .select('id');
  if (deleteError) errors.push(`Deleting duplicate rows: ${deleteError.message}`);
  else duplicatesDeleted = deleted?.length ?? 0;

  for (const [bookmakerPlayerName, playerId] of Object.entries(BOOKMAKER_NAME_TO_PLAYER_ID)) {
    const { data, error } = await supabase
      .from('bookmaker_odds')
      .update({
        player_id: playerId,
        resolution_status: 'relinked',
        resolution_reason: bookmakerPlayerName === 'Bailey J. Williams'
          ? 'manual_repair_r20_fre_wce_disambiguated'
          : 'manual_repair_r20_fre_wce',
      })
      .eq('match_id', MATCH_ID)
      .eq('bookmaker_player_name', bookmakerPlayerName)
      .is('player_id', null)
      .select('id');
    if (error) errors.push(`Relinking odds for ${bookmakerPlayerName}: ${error.message}`);
    else oddsRelinked += data?.length ?? 0;
  }

  return { statsLinked, duplicatesDeleted, oddsRelinked, errors };
}
